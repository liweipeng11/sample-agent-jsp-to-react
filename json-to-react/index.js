import express from 'express';
import JSON5 from 'json5';
import { parse } from '@babel/parser'; // <<< 新增：引入Babel解析器
import { tools, filterAndGenerateReactComponent } from "./tools/tools.js";
import { 
    openai, 
    sessions, 
    fixJsonWithLlm, 
    normalizeToolCallsWithLlm,
    initializeSession 
} from "../utils/common.js";

// 创建路由实例而不是应用实例
const router = express.Router();

// 系统提示 (保持不变)
const systemPrompt = `你是一位顶尖的React.js资深开发者，专注于将结构化的JSON中间表示（IR）精确地转换为高效、可维护的React JSX代码。
根据提供的JSON数据生成React组件(JSX格式)，严格遵循以下规则：
1. 仅转换body内的子元素，忽略html/head/body/script/meta标签
2. HTML标准标签必须使用完整闭合语法（如<div></div>）
3. 变量使用useState声明，禁止使用useEffect初始化
4. 事件处理函数只需定义名称，内容统一用console.log()实现
5. 遇到body标签时仅处理其children属性
6. isComponent为true时为组件引用，componentUrl为组件地址
7. 完全忽略title标签
8. 正确解析<%...%>中的变量和条件表达式
9. 最终输出必须是完整的JSX文件内容
10. 最终输出必须是一个有效的、经过清理的jsx代码，不包含任何解释、注释或Markdown代码块。
请提供需要转换的JSON数据，我将严格按照上述规则生成对应的React JSX组件代码。`;

// --- React专用的工具处理函数 --- (保持不变)
async function handleReactToolCalls(toolCalls, sessionId) {
    if (!toolCalls || toolCalls.length === 0) return [];
    if (!sessions[sessionId]) sessions[sessionId] = [];

    console.log(`开始执行 ${toolCalls.length} 个工具调用...`);

    const tasks = toolCalls.map((toolCall) => async () => {
        const functionCall = toolCall.function;
        const toolName = functionCall.name;
        const toolCallId = toolCall.id;

        if (toolName !== 'filterAndGenerateReactComponent') {
            const errorResult = { error: `工具 '${toolName}' 不存在。` };
            sessions[sessionId].push({
                role: "tool", tool_call_id: toolCallId, content: JSON.stringify(errorResult)
            });
            return;
        }

        try {
            let args;
            const rawArguments = functionCall.arguments;
            console.log(`模型 [${toolName}] 返回的原始参数:`, rawArguments);

            try {
                args = JSON5.parse(rawArguments);
                console.log("第一级解析 (JSON5) 成功。");
            } catch (e1) {
                console.warn("第一级解析失败，尝试 LLM 修复...");
                const fixedJsonString = await fixJsonWithLlm(rawArguments);
                args = JSON.parse(fixedJsonString);
                console.log("第二级解析 (LLM 修复后) 成功。");
            }

            const result = await filterAndGenerateReactComponent(args.unfilteredJson);
            console.log(`${toolName} 工具执行结果:`, result);

            sessions[sessionId].push({
                role: "tool",
                tool_call_id: toolCallId,
                name: toolName,
                content: JSON.stringify(result.elements),
            });

        } catch (error) {
            console.error(`执行工具 ${toolName} 出错:`, error);
            const errMsg = { error: `执行工具时出错: ${error.message}` };
            sessions[sessionId].push({
                role: "tool", tool_call_id: toolCallId, name: toolName, content: JSON.stringify(errMsg)
            });
        }
    });

    await Promise.all(tasks.map(task => task()));
    console.log("所有工具调用完成 ✅");
}

// --- 新增：代码验证与修复辅助函数 ---

/**
 * 使用 @babel/parser 验证生成的React代码是否存在语法错误。
 * 如果代码无效，它将抛出一个错误。
 * @param {string} code - 要验证的React代码字符串。
 */
async function validateJsxSyntax(code) {
    try {
        parse(code, {
            sourceType: 'module',
            plugins: ['jsx'], // 启用JSX插件
        });
    } catch (error) {
        console.error("JSX语法验证失败:", error.message);
        const syntaxError = new Error(`JSX语法无效: ${error.message}`);
        syntaxError.code = code; // 将错误代码附加到error对象上，便于返回
        throw syntaxError;
    }
}

/**
 * 使用大模型检查并修复React组件中未声明的变量。
 * @param {string} code - 语法正确的React代码。
 * @returns {Promise<string>} - 修复了变量声明的代码。
 */
async function fixUndeclaredVariables(code) {
    const repairPrompt = `你是一位React专家。你的任务是修复一段React组件代码。
请检查以下代码，识别所有被使用但未声明的变量。
对于每一个未声明的变量，必须在组件顶部使用 'useState' hook 进行初始化。
关键规则：初始化时，必须同时声明变量本身及其对应的setter函数。
例如：如果发现变量 'userName' 未声明，你应该添加 'const [userName, setUserName] = useState(undefined);'。
不要修改任何已有的代码逻辑，只在顶部添加必要的 'useState' 声明。
最终只返回完整的、修复后的JSX代码，不包含任何解释或Markdown。`;

    try {
        const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            messages: [
                { role: "system", content: repairPrompt },
                { role: "user", content: code }
            ],
            temperature: 0,
        });
        
        let fixedCode = response.choices[0].message.content || "";
        // 清理可能出现的Markdown代码块
        fixedCode = fixedCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');
        
        console.log("变量修复模型返回的代码:", fixedCode);
        return fixedCode;

    } catch (error) {
        console.error("使用大模型修复变量时出错:", error);
        throw new Error("使用大模型修复变量时失败。");
    }
}


// --- API 路由 (已更新验证逻辑) ---
router.post('/generate-react', async (req, res) => {
    try {
        const { message, sessionId = `session_${Date.now()}` } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'message 不能为空' });
        }

        initializeSession(sessionId, systemPrompt);
        sessions[sessionId].push({ role: "user", content: `请根据以下JSON生成React组件: ${message}` });

        const needsFiltering = /"tagName"\s*:\s*"(html|head|body|title|script|meta|noscript|link)"/i.test(message);
        console.log(`是否需要调用过滤工具? ${needsFiltering}`);

        const apiRequestOptions = {
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            messages: sessions[sessionId],
        };

        if (needsFiltering) {
            apiRequestOptions.tools = tools;
            apiRequestOptions.tool_choice = "auto";
        }
        
        const plannerResponse = await openai.chat.completions.create(apiRequestOptions);
        const responseMessage = plannerResponse.choices[0].message;

        let toolCallsToProcess = responseMessage.tool_calls || [];

        if (toolCallsToProcess.length === 0 && responseMessage.content) {
            console.log("未找到标准 tool_calls，尝试从 content 内容中规范化...");
            const normalizedCalls = await normalizeToolCallsWithLlm(responseMessage.content);
            if (normalizedCalls.length > 0) {
                toolCallsToProcess = normalizedCalls;
                responseMessage.tool_calls = normalizedCalls;
                console.log("已成功从 content 中规范化工具调用。");
            }
        }

        sessions[sessionId].push(responseMessage);
        
        const hasToolCalls = toolCallsToProcess && toolCallsToProcess.length > 0;

        if (hasToolCalls) {
            console.log("助手决定使用工具，开始执行...");
            await handleReactToolCalls(toolCallsToProcess, sessionId);
        } else {
            console.log("助手未调用工具，将对直接生成的内容进行验证。");
        }

        // --- 统一的代码生成、验证与修复循环 ---
        let finalReactCode = "";
        let isCodeValid = false;
        let attempts = 0;
        const maxAttempts = 3;
        let generatedCode = "";

        console.log("启动统一的 LLM 代码生成与验证循环...");

        while (!isCodeValid && attempts < maxAttempts) {
            attempts++;
            console.log(`--- 开始第 ${attempts}/${maxAttempts} 次代码生成与验证 ---`);
            
            try {
                // 步骤 1: 生成或获取代码
                // 如果是首次尝试且没有工具调用，则直接使用模型初次返回的内容。
                // 否则，需要调用模型根据当前会话（可能包含工具结果或错误信息）来生成新代码。
                if (attempts === 1 && !hasToolCalls) {
                    console.log("使用模型初次生成的内容进行验证...");
                    generatedCode = responseMessage.content || "";
                } else {
                    console.log("调用 LLM 生成/修复代码...");
                    const finalResponse = await openai.chat.completions.create({
                        model: process.env.OPENAI_MODEL || "qwen3-coder",
                        messages: sessions[sessionId],
                        temperature: 0.1 * attempts, // 每次重试稍微增加一点随机性
                    });

                    generatedCode = finalResponse.choices[0].message.content || "";
                    // 将本次生成结果存入会话，以便下次生成时模型能看到历史记录
                    sessions[sessionId].push(finalResponse.choices[0].message);
                }

                generatedCode = generatedCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');
                if (!generatedCode) {
                    throw new Error("模型生成了空代码。");
                }

                // 步骤 2: 验证JSX语法
                console.log("步骤 2/3: 验证JSX语法...");
                await validateJsxSyntax(generatedCode);
                console.log("✅ JSX语法正确。");

                // 步骤 3: 检查并修复未声明的变量
                console.log("步骤 3/3: 检查并修复未声明的变量...");
                finalReactCode = await fixUndeclaredVariables(generatedCode);
                console.log("✅ 变量修复完成。");
                
                isCodeValid = true; // 所有步骤成功，退出循环

            } catch (error) {
                console.warn(`第 ${attempts} 次尝试失败: ${error.message}`);
                finalReactCode = generatedCode || (error.code || "生成代码为空"); // 保存失败的代码用于返回
                
                // 仅在还有重试机会时，将错误信息加入会话，告知模型上次为何失败
                if (attempts < maxAttempts) {
                    sessions[sessionId].push({
                        role: "user",
                        content: `你上次生成的代码存在以下错误，请修复它并重新生成：\n${error.message}`
                    });
                } else {
                    console.error("已达到最大尝试次数，将返回最后一次的错误结果。");
                }
            }
        }
        
        if (isCodeValid) {
            console.log("代码生成与验证成功 ✅")
            res.json({ success: true, reactCode: finalReactCode, sessionId });
        } else {
            res.status(500).json({
                success: false,
                error: "代码生成失败，已达到最大重试次数。",
                reactCode: finalReactCode, // 返回最后一次生成的（错误）代码
                sessionId
            });
        }

    } catch (error) {
        console.error("处理请求时出错:", error);
        res.status(500).json({ error: error.message });
    }
});

// 导出路由而不是启动服务器
export default router;