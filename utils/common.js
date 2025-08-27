import OpenAI from "openai";
import JSON5 from 'json5';
import dotenv from 'dotenv';

dotenv.config();

// 初始化 OpenAI 客户端
export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE,
    timeout: 1000000
});

// 存储用户会话
export const sessions = {};

// --- JSON 修复工具 ---
export async function fixJsonWithLlm(brokenJsonString) {
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

// --- 工具调用规范化（先正则解析，失败再走 LLM） ---
export async function normalizeToolCallsWithLlm(rawContent) {
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
                const paramName = paramMatch ? paramMatch[1].trim() : null;
                const paramValue = paramMatch ? paramMatch[2].trim() : "";

                const parsed = [{
                    id: "call_" + Date.now() + "_" + i,
                    type: "function",
                    function: {
                        name: toolName,
                        arguments: JSON.stringify(paramName ? { [paramName]: paramValue } : {})
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

// --- 并发执行工具调用（带并发限制） ---
const MAX_CONCURRENT = 2; // 每次最多并发执行 2 个工具

// 通用的并发限制执行器
export async function runWithConcurrencyLimit(tasks, limit) {
    const results = [];
    const executing = new Set();

    for (const task of tasks) {
        const p = task().finally(() => executing.delete(p));
        results.push(p);
        executing.add(p);

        if (executing.size >= limit) {
            await Promise.race(executing); // 等一个执行完再继续
        }
    }
    return Promise.all(results);
}

export async function handleToolCalls(toolCalls, sessionId, availableTools) {
    if (!toolCalls || toolCalls.length === 0) return [];
    if (!sessions[sessionId]) sessions[sessionId] = [];

    console.log(`开始执行 ${toolCalls.length} 个工具调用...`);

    // 将每个工具调用包装成任务函数
    const tasks = toolCalls.map((toolCall) => async () => {
        const functionCall = toolCall.function;
        const toolName = functionCall.name;
        const toolCallId = toolCall.id;

        const toolToCall = availableTools[toolName];
        if (!toolToCall) {
            const errorResult = { error: `工具 '${toolName}' 不存在。` };
            sessions[sessionId].push({
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(errorResult)
            });
            return { toolName, toolCallId, error: errorResult.error };
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

            const result = await toolToCall(args);
            console.log(`${toolName} 工具执行结果:`, result);

            sessions[sessionId].push({
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(result)
            });

            return { toolName, toolCallId, result };

        } catch (error) {
            console.error(`执行工具 ${toolName} 出错:`, error);
            const errMsg = { error: `执行工具时出错: ${error.message}` };
            sessions[sessionId].push({
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify(errMsg)
            });
            return { toolName, toolCallId, error: error.message };
        }
    });

    // 使用并发限制执行任务
    const results = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT);

    console.log("所有工具调用完成 ✅");
    return results;
}

// 会话管理工具函数
export function getSession(sessionId) {
    return sessions[sessionId];
}

export function deleteSession(sessionId) {
    if (sessions[sessionId]) {
        delete sessions[sessionId];
        return true;
    }
    return false;
}

export function initializeSession(sessionId, systemMessage) {
    if (!sessions[sessionId]) {
        sessions[sessionId] = [
            {
                role: "system",
                content: systemMessage
            }
        ];
    }
}