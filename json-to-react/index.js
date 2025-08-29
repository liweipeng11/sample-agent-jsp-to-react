import express from 'express';
import JSON5 from 'json5';
import { parse } from '@babel/parser'; // <<< 新增：引入Babel解析器
import { tools, filterAndGenerateReactComponent,handleRouteOutlet,handleActiveXPlaceholder } from "./tools/tools.js";
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
1. HTML标准标签必须使用完整闭合语法（如<div></div>）
2. 变量使用useState声明，禁止使用useEffect初始化
3. 事件处理函数只需定义名称，内容统一用console.log()实现
4. isComponent为true时为组件引用，componentUrl为组件地址
5. 正确解析<%...%>中的变量和条件表达式
6. 最终输出必须是一个有效的、经过清理的jsx代码，不包含任何解释、注释或Markdown代码块。
7. 当处理tagName为'RouteOutlet'的节点或收到来自'handleRouteOutlet'工具的结果时，你必须:
    a. 在文件顶部导入 'useNavigate' hook: import { useNavigate } from 'react-router-dom';
    b. 在组件函数顶部初始化hook: const navigate = useNavigate();
    c. 将该节点渲染为一个可点击的元素(例如<div>)，其onClick事件处理器调用 navigate() 函数进行跳转，跳转路径由节点的'to'属性或工具结果中的'path'字段指定。
8. 当处理tagName为'ActiveXPlaceholder'的节点必须使用'handleActiveXPlaceholder'工具，收到来自'handleActiveXPlaceholder'工具的结果时，你必须:
    a. 创建一个新的React组件（如果它还不存在），其名称由工具结果中的 'componentName' 字段指定。
    b. 这个组件必须渲染一个带有明显警告样式（例如，红色虚线边框和浅红色背景）的 <div>。
    c. 在 <div> 内部，必须包含一个醒目的H3标题，内容为 "TODO: 替换遗留ActiveX控件"。
    d. 在标题下方，必须使用 <pre><code> 标签，将从工具结果的 'props' 字段接收到的所有属性和参数，格式化为JSON字符串并完整显示出来。
    e. 在组件文件的顶部，必须添加一个详细的多行注释，解释这个占位符的来源、风险以及需要开发人员采取的行动。
请提供需要转换的JSON数据，我将严格按照上述规则生成对应的React JSX组件代码。`;

// --- React专用的工具处理函数 --- (保持不变)
async function handleReactToolCalls(toolCalls, sessionId) {
    if (!toolCalls || toolCalls.length === 0) return [];
    if (!sessions[sessionId]) sessions[sessionId] = [];

    console.log(`开始执行 ${toolCalls.length} 个工具调用...`);

    // 注意：这里的并行执行逻辑将在后续的路由处理中被分阶段调用，从而保证顺序。
    // 函数本身保持不变，但调用它的方式会改变。
    const tasks = toolCalls.map((toolCall) => async () => {
        const functionCall = toolCall.function;
        const toolName = functionCall.name;
        const toolCallId = toolCall.id;

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

            let result;
            // <<< 修改：使用 switch 支持所有工具 >>>
            switch (toolName) {
                case 'filterAndGenerateReactComponent':
                    const filterResult = await filterAndGenerateReactComponent(args.unfilteredJson);
                    // 返回清理后的核心 elements 数组
                    result = filterResult.elements; 
                    break;
                case 'handleRouteOutlet':
                    result = await handleRouteOutlet(args);
                    break;
                case 'handleActiveXPlaceholder': // <<< 新增：处理 ActiveXPlaceholder 的 case
                    result = await handleActiveXPlaceholder(args);
                    break;
                default:
                    const errorResult = { error: `工具 '${toolName}' 不存在或在此上下文中不适用。` };
                    sessions[sessionId].push({
                        role: "tool", tool_call_id: toolCallId, content: JSON.stringify(errorResult)
                    });
                    return;
            }
            
            console.log(`${toolName} 工具执行结果:`, result);

            sessions[sessionId].push({
                role: "tool",
                tool_call_id: toolCallId,
                name: toolName,
                content: JSON.stringify(result),
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
        
        // 初始用户消息，定义为变量以便后续可能被覆盖
        let currentUserContent = `请根据以下JSON生成React组件: ${message}`;
        sessions[sessionId].push({ role: "user", content: currentUserContent });

        // --- 阶段一: 过滤检查与执行 ---
        const needsFiltering = /"tagName"\s*:\s*"(html|head|body|title|script|meta|noscript|link)"/i.test(message);
        console.log(`是否需要调用过滤工具? ${needsFiltering}`);

        if (needsFiltering) {
            console.log("--- 进入过滤阶段 ---");
            // 在此阶段，我们强制模型只使用过滤工具
            const filterPlannerResponse = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "gpt-4-turbo",
                messages: sessions[sessionId],
                tools: tools.filter(t => t.function.name === 'filterAndGenerateReactComponent'), // 只提供过滤工具
                tool_choice: { type: "function", function: { name: "filterAndGenerateReactComponent" } }, // 强制调用
            });

            const filterResponseMessage = filterPlannerResponse.choices[0].message;
            sessions[sessionId].push(filterResponseMessage); // 保存模型的决策

            if (filterResponseMessage.tool_calls && filterResponseMessage.tool_calls.length > 0) {
                await handleReactToolCalls(filterResponseMessage.tool_calls, sessionId);
                console.log("过滤工具执行完毕。");
                // 过滤完成后，更新用户消息，让下一阶段基于清理后的JSON工作
                // 注意：我们将工具返回的清理后的JSON作为新的用户指令，这样更清晰
                const lastToolResult = sessions[sessionId][sessions[sessionId].length - 1];
                currentUserContent = `过滤完成。请根据以下清理后的JSON数据生成React组件: ${lastToolResult.content}`;
                sessions[sessionId].push({ role: "user", content: currentUserContent });
            } else {
                console.warn("模型决定需要过滤但未成功调用过滤工具，流程将继续使用原始JSON。");
            }
        }

        // --- 阶段二: 组件生成与功能性工具调用 ---
        console.log("--- 进入组件生成阶段 ---");
        // 在此阶段，模型可以使用除过滤工具外的所有其他工具
        const componentGenPlannerResponse = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            messages: sessions[sessionId],
            tools: tools, // 提供所有工具，让模型自行决策（过滤工具此时不会被触发）
            tool_choice: "auto",
        });

        const genResponseMessage = componentGenPlannerResponse.choices[0].message;
        sessions[sessionId].push(genResponseMessage);

        let toolCallsToProcess = genResponseMessage.tool_calls || [];

        // (此处的规范化逻辑保持不变)
        if (toolCallsToProcess.length === 0 && genResponseMessage.content) {
            console.log("未找到标准 tool_calls，尝试从 content 内容中规范化...");
            const normalizedCalls = await normalizeToolCallsWithLlm(genResponseMessage.content);
            if (normalizedCalls.length > 0) {
                toolCallsToProcess = normalizedCalls;
                genResponseMessage.tool_calls = normalizedCalls;
            }
        }

        const hasToolCalls = toolCallsToProcess && toolCallsToProcess.length > 0;
        if (hasToolCalls) {
            console.log("助手决定使用功能性工具 (如路由、占位符)，开始执行...");
            await handleReactToolCalls(toolCallsToProcess, sessionId);
        }

        // --- 统一的代码生成、验证与修复循环 (此部分逻辑保持不变) ---
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
                if (attempts === 1 && !hasToolCalls && !needsFiltering) {
                    generatedCode = genResponseMessage.content || "";
                } else {
                    const finalResponse = await openai.chat.completions.create({
                        model: process.env.OPENAI_MODEL || "qwen3-coder",
                        messages: sessions[sessionId],
                        temperature: 0.1 * attempts,
                    });
                    generatedCode = finalResponse.choices[0].message.content || "";
                    sessions[sessionId].push(finalResponse.choices[0].message);
                }

                generatedCode = generatedCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');
                if (!generatedCode) throw new Error("模型生成了空代码。");
                
                await validateJsxSyntax(generatedCode);
                finalReactCode = await fixUndeclaredVariables(generatedCode);
                isCodeValid = true;

            } catch (error) {
                console.warn(`第 ${attempts} 次尝试失败: ${error.message}`);
                finalReactCode = generatedCode || (error.code || "生成代码为空");
                if (attempts < maxAttempts) {
                    sessions[sessionId].push({
                        role: "user",
                        content: `你上次生成的代码存在以下错误，请修复它并重新生成：\n${error.message}`
                    });
                }
            }
        }
        
        if (isCodeValid) {
            res.json({ success: true, reactCode: finalReactCode, sessionId });
        } else {
            res.status(500).json({
                success: false,
                error: "代码生成失败，已达到最大重试次数。",
                reactCode: finalReactCode,
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