import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import OpenAI from "openai";
import JSON5 from 'json5';
import dotenv from 'dotenv';
import { tools, filterAndGenerateReactComponent } from "./tools/tools.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3081;

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE,
    timeout: 1000000
});

// 存储用户会话
const sessions = {};

// 系统提示
const systemPrompt = `你是一位顶尖的React.js资深开发者，专注于将结构化的JSON中间表示（IR）精确地转换为高效、可维护的React JSX代码。
根据提供的JSON数据生成React组件(JSX格式)，严格遵循以下规则：
1. 仅转换body内的子元素，忽略html/head/body/script/meta标签
2. HTML标准标签必须使用完整闭合语法（如<div></div>）
3. 变量使用useState声明，禁止使用useEffect初始化
4. 事件处理函数只需定义名称，内容统一用console.log()实现
5. 遇到body标签时仅处理其children属性
6. 组件文件名首字母大写并使用.jsx后缀
7. 完全忽略title标签
8. 正确解析<%...%>中的变量和条件表达式
9. 最终输出必须是完整的JSX文件内容
10. 不添加任何额外功能或解释性注释
请提供需要转换的JSON数据，我将严格按照上述规则生成对应的React JSX组件代码。`;

// --- [新增] JSON 修复工具 (完全来自 index.js) ---
async function fixJsonWithLlm(brokenJsonString) {
    console.log("启动 LLM 进行 JSON 修复...");
    try {
        const response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'qwen3-coder',
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: `你是一个专门修复 JSON 字符串的 AI 工具。
- 你的输出必须且只能是一个 JSON 对象或数组字符串。
- 不要添加解释、注释、代码块标记。
- 确保所有字符串内部的双引号都正确转义。`
                },
                { role: "user", content: brokenJsonString }
            ]
        });
        const fixedJson = response.choices[0].message.content;
        if (!fixedJson) throw new Error("LLM 修复返回空内容。");
        console.log("LLM 修复后的结果:", fixedJson);
        return fixedJson;
    } catch (error) {
        console.error("调用 LLM 修复 JSON 出错:", error);
        throw new Error("LLM-based JSON repair failed.");
    }
}

// --- [核心修改] 工具调用规范化 (与 index.js 完全一致的实现) ---
async function normalizeToolCallsWithLlm(rawContent) {
    if (!rawContent || !rawContent.includes('<tool_call>')) {
        return [];
    }

    console.log("检测到非标准工具调用格式，逐条分割处理...");
    const toolCallBlocks = rawContent.split(/<\/tool_call>/i).filter(Boolean).map(b => b + "</tool_call>");
    const allResults = [];

    for (let i = 0; i < toolCallBlocks.length; i++) {
        const block = toolCallBlocks[i];
        console.log(`处理第 ${i + 1} 个 tool_call 片段...`);
        console.log(`片段内容: ${block}`);

        try {
            // --- 尝试正则解析 ---
            const nameMatch = block.match(/<function\s*=\s*["']?([^>\s"']+)["']?\s*>/i);
            const paramMatch = block.match(/<parameter\s*=\s*["']?([^>\s"']+)["']?\s*>([\s\S]*?)<\/parameter>/i);

            if (nameMatch) {
                const toolName = nameMatch[1].trim();
                // 假设参数只有一个并且是unfilteredJson，这部分可以根据你的工具定制
                const paramValue = paramMatch ? paramMatch[2].trim() : "";

                const parsed = [{
                    id: "call_" + Date.now() + "_" + i,
                    type: "function",
                    function: {
                        name: toolName,
                        // 这里我们假设参数的key固定为unfilteredJson，以匹配你的工具
                        arguments: JSON.stringify({ unfilteredJson: paramValue })
                    }
                }];

                console.log("正则解析成功 ✅", parsed);
                allResults.push(...parsed);
                continue; // 本条解析成功，不走 LLM
            }

            // --- 如果正则解析失败，才走 LLM ---
            console.warn("正则解析失败，尝试使用 LLM 规范化...");
            const response = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'qwen3-coder',
                temperature: 0,
                messages: [
                    {
                        role: "system",
                        content: `你是一个 AI 助手，专门将单个 <tool_call> 片段转换为严格的 OpenAI tool_calls JSON 格式。
- 输入：一个 <tool_call>...</tool_call> 片段
- 输出：一个 JSON 数组，里面只有一个对象
- arguments 必须是 JSON 字符串
- 输出必须是严格 JSON，不要解释或 markdown 包裹`
                    },
                    { role: "user", content: block }
                ]
            });

            const jsonOutput = response.choices[0].message.content;
            console.log("LLM 规范化后的单条输出:", jsonOutput);

            let parsed;
            try {
                parsed = JSON.parse(jsonOutput);
            } catch (e1) {
                console.warn(`解析失败，尝试 LLM 修复: ${e1.message}`);
                const fixed = await fixJsonWithLlm(jsonOutput);
                parsed = JSON.parse(fixed);
            }

            if (Array.isArray(parsed)) {
                allResults.push(...parsed);
            }
        } catch (err) {
            console.error(`处理第 ${i + 1} 个 tool_call 出错:`, err);
        }
    }

    return allResults;
}

// --- [重构] 统一的工具处理函数 (结合了 index.js 的错误处理和JSON修复) ---
async function handleToolCalls(toolCalls, sessionId) {
    if (!toolCalls || toolCalls.length === 0) return [];
    if (!sessions[sessionId]) sessions[sessionId] = [];

    console.log(`开始执行 ${toolCalls.length} 个工具调用...`);

    const tasks = toolCalls.map((toolCall) => async () => {
        const functionCall = toolCall.function;
        const toolName = functionCall.name;
        const toolCallId = toolCall.id;

        // 仅处理我们期望的工具
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

            // 第一级解析: 尝试使用 JSON5 (更宽松)
            try {
                args = JSON5.parse(rawArguments);
                console.log("第一级解析 (JSON5) 成功。");
            } catch (e1) {
                // 第二级解析: 如果 JSON5 失败，调用 LLM 修复
                console.warn("第一级解析失败，尝试 LLM 修复...");
                const fixedJsonString = await fixJsonWithLlm(rawArguments);
                args = JSON.parse(fixedJsonString); // 修复后应该能被标准 JSON 解析
                console.log("第二级解析 (LLM 修复后) 成功。");
            }

            // 执行工具函数
            const result = filterAndGenerateReactComponent(args.unfilteredJson);
            console.log(`${toolName} 工具执行结果:`, result);

            // 将结果存入会话
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

    // 并发执行所有任务
    await Promise.all(tasks.map(task => task()));
    console.log("所有工具调用完成 ✅");
}


// --- [重构] API 路由，集成新的工具调用处理逻辑 ---
app.post('/api/generate-react', async (req, res) => {
    try {
        const { message, sessionId = `session_${Date.now()}` } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'message 不能为空' });
        }

        if (!sessions[sessionId]) {
            sessions[sessionId] = [{ role: "system", content: systemPrompt }];
        }
        sessions[sessionId].push({ role: "user", content: `请根据以下JSON生成React组件: ${message}` });

        // 检查输入是否包含需要清理的标签
        const needsFiltering = /"tagName"\s*:\s*"(html|head|body|title)"/i.test(message);
        console.log(`是否需要调用过滤工具? ${needsFiltering}`);

        // 准备 API 请求参数
        const apiRequestOptions = {
            model: process.env.OPENAI_MODEL || "gpt-4-turbo",
            messages: sessions[sessionId],
        };

        // 只有在需要时才向模型提供工具信息
        if (needsFiltering) {
            apiRequestOptions.tools = tools;
            apiRequestOptions.tool_choice = "auto";
        }
        // 第一步：让 LLM 规划（根据条件可能包含工具）
        const plannerResponse = await openai.chat.completions.create(apiRequestOptions);
        const responseMessage = plannerResponse.choices[0].message;

        // --- 核心修改点：获取并规范化 tool_calls ---
        let toolCallsToProcess = responseMessage.tool_calls || [];

        // 如果标准 tool_calls 为空，但 content 中有内容，则尝试从 content 中解析
        if (toolCallsToProcess.length === 0 && responseMessage.content) {
            console.log("未找到标准 tool_calls，尝试从 content 内容中规范化...");
            const normalizedCalls = await normalizeToolCallsWithLlm(responseMessage.content);
            if (normalizedCalls.length > 0) {
                toolCallsToProcess = normalizedCalls;
                // 将规范化后的结果附加到消息上，以保持历史记录的完整性
                responseMessage.tool_calls = normalizedCalls;
                console.log("已成功从 content 中规范化工具调用。");
            }
        }
        // --- 核心修改结束 ---

        sessions[sessionId].push(responseMessage);

        if (toolCallsToProcess && toolCallsToProcess.length > 0) {
            console.log("助手决定使用工具，开始执行...");
            await handleToolCalls(toolCallsToProcess, sessionId);

            console.log("工具执行完毕，启动 LLM 整合结果...");
            const finalResponse = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                messages: sessions[sessionId],
                temperature: 0,
            });

            let reactCode = finalResponse.choices[0].message.content || "";
            reactCode = reactCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');

            sessions[sessionId].push(finalResponse.choices[0].message);
            console.log("整合结果完成 ✅")
            res.json({ success: true, reactCode, sessionId });

        } else {
            console.log("助手未调用工具，直接返回内容。");
            let reactCode = responseMessage.content || "";
            reactCode = reactCode.replace(/^```(tsx|jsx|javascript|js)?\n/i, '').replace(/\n```$/, '');
            res.json({
                success: true,
                reactCode,
                warning: "模型没有调用过滤工具，结果可能不准确。",
                sessionId
            });
        }
    } catch (error) {
        console.error("处理请求时出错:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`JSON 转 React 服务已启动，监听端口 ${port}`);
});