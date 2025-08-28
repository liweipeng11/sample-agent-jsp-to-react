import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { availableTools, tools } from "./tools/tools.js";
import {
    openai,
    sessions,
    fixJsonWithLlm,
    normalizeToolCallsWithLlm,
    handleToolCalls,
    initializeSession,
    getSession,
    deleteSession
} from "../utils/common.js";

// 创建路由实例而不是应用实例
const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 辅助函数 ---

/**
 * 递归地遍历一个代表HTML树的JSON对象。
 * 如果找到一个'table'标签，其直接子元素没有被'tbody'包裹，
 * 该函数会创建一个'tbody'元素并将所有子元素移入其中。
 * 此函数现在使用 'tagName' 属性，以匹配您提供的JSON格式。
 * @param {any} node - JSON树中的当前节点（对象或数组）。
 */
function traverseAndFixTables(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(item => traverseAndFixTables(item));
        return;
    }

    // 首先，递归处理子节点
    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndFixTables(child));
    }

    // 检查当前节点是否是需要修复的table
    const isTable = node.tagName === 'table';
    const hasChildren = node.children && Array.isArray(node.children) && node.children.length > 0;

    if (isTable && hasChildren) {
        // 如果第一个子节点不是tbody，我们就需要包裹它们
        const needsTbody = node.children[0].tagName !== 'tbody';

        if (needsTbody) {
            console.log("发现一个 <table> 缺少 <tbody>，正在包裹其子元素...");
            const originalChildren = node.children;
            // 创建新的tbody元素，使用 'tagName'
            const tbodyElement = {
                tagName: 'tbody',
                children: originalChildren
            };
            // 用只包含新tbody的数组替换table的子元素
            node.children = [tbodyElement];
        }
    }
}


/**
 * 确保从LLM获取的内容是有效的JSON，如果不是则要求LLM重新生成，最多重试3次。
 * @param {string} sessionId - 当前会话的ID。
 * @param {string} initialContent - LLM的初次响应内容。
 * @returns {Promise<string>} - 经过验证和处理后的JSON字符串。
 */
async function generateAndValidateJson(sessionId, initialContent) {
    let currentContent = initialContent;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            let parsedJson = JSON.parse(currentContent);
            console.log(`Attempt ${attempt}: JSON is valid.`);
            traverseAndFixTables(parsedJson.elements);
            return JSON.stringify(parsedJson, null, 2); // 成功，返回格式化后的JSON
        } catch (error) {
            console.error(`Attempt ${attempt}/${maxAttempts} failed: Content is not valid JSON.`);

            if (attempt >= maxAttempts) {
                throw new Error("Failed to generate valid JSON after multiple attempts.");
            }

            // 将失败的尝试和修正提示添加到会话历史
            sessions[sessionId].push({ role: "assistant", content: currentContent });
            sessions[sessionId].push({
                role: "user",
                content: "整合结果错误，请重新整合"
            });

            console.log("Requesting regeneration from LLM...");
            const stream = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                messages: sessions[sessionId],
                temperature: 0,
                stream: true,
            });

            let regeneratedContent = "";
            for await (const chunk of stream) {
                regeneratedContent += chunk.choices[0]?.delta?.content || "";
            }
            currentContent = regeneratedContent; // 更新内容以供下次循环尝试
        }
    }
}


// --- API 路由 ---
router.post('/chat', async (req, res) => {
    try {
        const { message, sessionId = 'default' } = req.body;
        console.log("收到请求 sessionId:", sessionId);

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        initializeSession(sessionId, `你是一位专业的AI代码助手。你的核心任务是根据用户的需求，独立完成代码的编写、重构或解释，并始终以一个完整的JSON对象作为最终输出。

规则：
- 自主优先: 优先尝试自己直接完成用户的请求。
- 工具辅助: 当你遇到需要转换的特定标签片段时（例如JSP自定义标签、Struts标签库，或像 <font> 这样的废弃HTML标签），必须调用 'convertJspSnippet' 工具进行处理。
- 样式修复（重要）: 任何时候只要发现属性 'style' 是字符串或存在不规范写法（如下划线/星号 hack、大小写混乱、缺失单位、连字符属性名等），必须优先调用 'normalizeStyleWithLlm' 工具获得修复后的 JSON 样式对象，并用结果替换原有的 style。
- 调用时只传递最小片段。
- 如果片段中有多个需要转换的标签，请调用工具多次，每次传入一个完整标签。
- 合并工作流:
   a. 在代码中插入 <!--MCP_TOOL_RESULT_HERE--> 占位符。
   b. 发起工具调用。
   c. 收到结果后整合，输出完整代码。
- 输出格式：最终的、完整的响应必须是一个JSON对象，没有任何其他文本或解释。`);

        sessions[sessionId].push({ role: "user", content: message });

        // 第一步：让 LLM 规划
        const plannerResponse = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || "qwen3-coder",
            messages: sessions[sessionId],
            temperature: 0,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = plannerResponse.choices[0].message;
        let finalContent;
        let toolResultsForResponse = null;

        // 检查工具调用
        let toolCallsToProcess = responseMessage.tool_calls || [];
        if (toolCallsToProcess.length === 0 && responseMessage.content) {
            const normalizedCalls = await normalizeToolCallsWithLlm(responseMessage.content);
            if (normalizedCalls.length > 0) {
                toolCallsToProcess = normalizedCalls;
                responseMessage.tool_calls = normalizedCalls;
            }
        }

        sessions[sessionId].push(responseMessage);

        // --- 工具调用分支 ---
        if (toolCallsToProcess && toolCallsToProcess.length > 0) {
            console.log("助手决定使用工具，开始执行...");
            const toolResults = await handleToolCalls(toolCallsToProcess, sessionId, availableTools);
            toolResultsForResponse = toolResults;

            console.log("工具执行完毕，启动 LLM 整合结果...");
            sessions[sessionId].push({
                role: "user",
                content: "你已经完成了工具调用，现在请整合结果并只输出 JSON"
            });
            let integrationContent = "";
            const stream = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                messages: sessions[sessionId],
                temperature: 0,
                stream: true,
                response_format: { type: "json_object" }
            });

            for await (const chunk of stream) {
                integrationContent += chunk.choices[0]?.delta?.content || "";
            }

            // 验证并可能重新生成内容以确保它是JSON
            finalContent = await generateAndValidateJson(sessionId, integrationContent);

        } else {
            // --- 无需工具 ---
            // 验证并可能重新生成内容以确保它是JSON
            finalContent = await generateAndValidateJson(sessionId, responseMessage.content);
        }

        // 将最终的、经过验证的助理响应添加到历史记录
        sessions[sessionId].push({ role: "assistant", content: finalContent });
        console.log("结果已返回");

        const responsePayload = {
            reply: finalContent,
            sessionId
        };
        if (toolResultsForResponse) {
            responsePayload.toolCalls = toolResultsForResponse;
        }

        return res.json(responsePayload);

    } catch (error) {
        console.error("处理请求时出错:", error);
        return res.status(500).json({ error: error.message });
    }
});

// 会话管理
router.get('/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: '会话不存在' });
    }
    return res.json({ history: session });
});

router.delete('/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const success = deleteSession(sessionId);
    return res.json({ success });
});

// 导出路由而不是启动服务器
export default router;