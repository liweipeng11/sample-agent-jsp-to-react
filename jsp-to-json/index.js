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



// --- API 路由 ---
router.post('/chat', async (req, res) => {
    try {
        const { message, sessionId = 'default' } = req.body;
        console.log("收到请求 sessionId:", sessionId);

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        initializeSession(sessionId, `你是一位专业的AI代码助手。你的核心任务是根据用户的需求，独立完成代码的编写、重构或解释。

规则：
- 自主优先: 优先尝试自己直接完成用户的请求。
- 工具辅助: 当你遇到需要转换的特定标签片段时（例如JSP自定义标签、Struts标签库，或像 <font> 这样的废弃HTML标签），必须调用 'convertJspSnippet' 工具进行处理。
- 样式修复（重要）: 任何时候只要发现属性 'style' 是字符串或存在不规范写法（如下划线/星号 hack、大小写混乱、缺失单位、连字符属性名等），必须优先调用 'normalizeStyleWithLlm' 工具获得修复后的 JSON 样式对象，并用结果替换原有的 style。
- 调用时只传递最小片段。
- 如果片段中有多个需要转换的标签，请调用工具多次，每次传入一个完整标签。
- 合并工作流:
   a. 在代码中插入 <!--MCP_TOOL_RESULT_HERE--> 占位符。
   b. 发起工具调用。
   c. 收到结果后整合，输出完整代码。`);

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

            console.log("工具执行完毕，启动 LLM 整合结果...");
            let fullContent = "";
            const stream = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                messages: sessions[sessionId],
                temperature: 0,
                stream: true,
            });

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content || "";
                if (delta) fullContent += delta;
            }

            sessions[sessionId].push({ role: "assistant", content: fullContent });
            console.log("结果已返回")
            return res.json({ reply: fullContent, toolCalls: toolResults, sessionId });

        } else {
            // --- 无需工具 ---
            sessions[sessionId].push({ role: "assistant", content: responseMessage.content });
            return res.json({ reply: responseMessage.content, sessionId });
        }
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