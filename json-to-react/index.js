import express from 'express';
import JSON5 from 'json5';
import { parse } from '@babel/parser';
import { tools, handleRouteOutlet, handleActiveXPlaceholder } from "./tools/tools.js";
import {
    openai,
    sessions,
    fixJsonWithLlm,
    normalizeToolCallsWithLlm,
    initializeSession
} from "../utils/common.js";

// 创建路由实例
const router = express.Router();

// 系统提示 (保持不变)
const systemPrompt = `你是一位顶尖的React.js资深开发者，专注于将结构化的JSON中间表示（IR）精确地转换为高效、可维护的React JSX代码。
根据提供的JSON数据生成React组件(JSX格式)，严格遵循以下规则：
1. 输出要保证是一个合法的React组件结构，并使用export default 导出
2. HTML标准标签必须使用完整闭合语法（如<div></div>）
3. 变量使用useState声明，禁止使用useEffect初始化
4. 事件处理函数只需定义名称，内容统一用console.log()实现
5. isComponent为true时为组件引用，componentUrl为组件地址
6. 正确解析<%...%>中的变量和条件表达式
7. 最终输出必须是完整的JSX文件内容
8. 最终输出必须是一个有效的、经过清理的jsx代码，不包含任何解释、注释或Markdown代码块。
9. 当处理tagName为'RouteOutlet'的节点或收到来自'handleRouteOutlet'工具的结果时，你必须:
    a. 在文件顶部导入 'useNavigate' hook: import { useNavigate } from 'react-router-dom';
    b. 在组件函数顶部初始化hook: const navigate = useNavigate();
    c. 将该节点渲染为一个可点击的元素(例如<div>)，其onClick事件处理器调用 navigate() 函数进行跳转，跳转路径由节点的'to'属性或工具结果中的'path'字段指定。
10. 当处理tagName为'ActiveXPlaceholder'的节点必须使用'handleActiveXPlaceholder'工具，收到来自'handleActiveXPlaceholder'工具的结果时，你必须:
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

    const tasks = toolCalls.map((toolCall) => async () => {
        const functionCall = toolCall.function;
        const toolName = functionCall.name;
        const toolCallId = toolCall.id;

        try {
            let args;
            const rawArguments = functionCall.arguments;

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
            switch (toolName) {
                case 'handleRouteOutlet':
                    result = await handleRouteOutlet(args);
                    break;
                case 'handleActiveXPlaceholder':
                    result = await handleActiveXPlaceholder(args);
                    break;
                default:
                    const errorResult = { error: `工具 '${toolName}' 不存在或在此上下文中不适用。` };
                    sessions[sessionId].push({
                        role: "tool", tool_call_id: toolCallId, content: JSON.stringify(errorResult)
                    });
                    return;
            }

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


// --- 代码验证与修复辅助函数 --- (保持不变)
async function validateJsxSyntax(code) {
    try {
        parse(code, {
            sourceType: 'module',
            plugins: ['jsx'],
        });
    } catch (error) {
        console.error("JSX语法验证失败:", error.message);
        const syntaxError = new Error(`JSX语法无效: ${error.message}`);
        syntaxError.code = code;
        throw syntaxError;
    }
}

async function fixUndeclaredVariables(code) {
    const repairPrompt = `你是一位React专家。你的任务是修复一段React组件代码。
请检查以下代码，识别所有被使用但未声明的变量。
对于每一个未声明的变量，必须在组件顶部使用 'useState' hook 进行初始化。
关键规则：初始化时，必须同时声明变量本身及其对应的setter函数。
例如：如果发现变量 'userName' 未声明，你应该添加 'const [userName, setUserName] = useState(undefined);'。
不要修改任何已有的代码逻辑，只在顶部添加必要的 'useState' 声明。
最终只返回完整的、修复后的JSX代码，不包含任何解释或Markdown。
特殊情况：
1.sessionStorage.getItem('someKey') 会被视为合法用法，无需修复。`;

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
        fixedCode = fixedCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');
        
        return fixedCode;

    } catch (error) {
        console.error("使用大模型修复变量时出错:", error);
        throw new Error("使用大模型修复变量时失败。");
    }
}


// <<< 修改：实现更智能的工具筛选函数 >>>
/**
 * 检查输入消息，并返回一个只包含实际所需工具的数组。
 * @param {string} message - 用户输入的JSON字符串。
 * @returns {Array|undefined} - 如果需要工具则返回一个包含所需工具对象的数组，否则返回undefined。
 */
function getRequiredToolsForMessage(message) {
    const requiredTools = [];

    // 定义每个工具名称与其在JSON中的触发关键字之间的映射
    const toolTriggerMap = {
        'handleRouteOutlet': '"tagName": "RouteOutlet"',
        'handleActiveXPlaceholder': '"tagName": "ActiveXPlaceholder"'
    };

    // 遍历所有可用的工具定义
    for (const tool of tools) {
        const toolName = tool.function.name;
        const triggerKeyword = toolTriggerMap[toolName];
        
        // 如果映射中存在该工具，并且message中包含了它的触发关键字
        if (triggerKeyword && message.includes(triggerKeyword)) {
            requiredTools.push(tool); // 将这个特定的工具添加到我们的列表中
            console.log(`检测到关键字，为请求添加工具: ${toolName}`);
        }
    }

    // 只有当列表中确实有工具时才返回数组，否则返回undefined
    if (requiredTools.length > 0) {
        return requiredTools;
    }

    console.log("未检测到需要特定工具处理的节点。");
    return undefined;
}


// --- API 路由 (已更新) ---
router.post('/generate-react', async (req, res) => {
    try {
        const { message, sessionId = `session_${Date.now()}` } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'message 不能为空' });
        }

        initializeSession(sessionId, systemPrompt);
        
        const currentUserContent = `请根据以下JSON生成React组件: ${message}`;
        sessions[sessionId].push({ role: "user", content: currentUserContent });

        // <<< 修改：调用新的、更智能的工具筛选函数 >>>
        const availableTools = getRequiredToolsForMessage(message);

        const openAiOptions = {
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            messages: sessions[sessionId],
        };

        if (availableTools) {
            openAiOptions.tools = availableTools;
            openAiOptions.tool_choice = "auto";
        }

        console.log("--- 进入组件生成阶段 ---");
        const componentGenPlannerResponse = await openai.chat.completions.create(openAiOptions);

        const genResponseMessage = componentGenPlannerResponse.choices[0].message;
        sessions[sessionId].push(genResponseMessage);

        let toolCallsToProcess = genResponseMessage.tool_calls || [];

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
            console.log("助手决定使用功能性工具，开始执行...");
            await handleReactToolCalls(toolCallsToProcess, sessionId);
        }

        // --- 统一的代码生成、验证与修复循环 (保持不变) ---
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
                if (attempts === 1 && !hasToolCalls) {
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
        console.log('结果已生成')
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

// 导出路由
export default router;