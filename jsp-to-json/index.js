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
 * 如果找到一个'object'标签（通常用于ActiveX），
 * 它会将其转换为一个 "ActiveXPlaceholder" 组件，
 * 并将所有 <param> 子标签的信息提取到一个 params 对象中。
 * @param {any} node - JSON树中的当前节点（对象或数组）。
 */
function traverseAndTransformObjects(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        // 如果是数组，则遍历数组中的每个元素
        node.forEach(item => traverseAndTransformObjects(item));
        return;
    }

    // 在处理当前节点之前，先递归处理其子节点
    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndTransformObjects(child));
    }

    // 检查当前节点是否是需要转换的 <object> 标签
    if (node.tagName === 'object') {
        console.log("发现一个 <object> 标签，正在转换为 ActiveXPlaceholder...");

        // 1. 提取所有 <param> 标签的 name 和 value
        const params = {};
        if (node.children && Array.isArray(node.children)) {
            node.children.forEach(child => {
                // 确保子节点是 <param> 并且有 attributes
                if (child.tagName === 'param' && child.attributes) {
                    const name = child.attributes.name;
                    const value = child.attributes.value;
                    if (name) { // 只有当 name 属性存在时才添加
                        params[name] = value || ""; // 如果 value 不存在，则设置为空字符串
                    }
                }
            });
        }

        // 2. 修改当前节点
        node.tagName = 'ActiveXPlaceholder'; // 修改 tagName
        node.isComponent = true;              // 标记为组件

        // 3. 用提取出的参数替换原来的 children
        // 这样可以清除掉原始的 <param> 节点，只保留关键信息
        node.children = [
            {
                // 我们将参数包裹在一个对象中，以保持结构清晰
                "params": params
            }
        ];
    }
}

/**
 * 辅助函数：将CSS字符串解析为CSS-in-JS对象。
 * 例如 "color: red; font-size: 12px" -> { color: "red", fontSize: "12px" }
 * @param {string} cssText - CSS样式字符串。
 * @returns {object} - CSS-in-JS格式的样式对象。
 */
function parseCssStringToObject(cssText) {
    if (typeof cssText !== 'string' || !cssText) {
        return {};
    }
    const style = {};
    cssText.split(';').forEach(declaration => {
        if (declaration.trim()) {
            const [property, value] = declaration.split(':');
            if (property && value) {
                const camelCaseProperty = property.trim().replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
                style[camelCaseProperty] = value.trim();
            }
        }
    });
    return style;
}


/**
 * (最终合并) 递归地遍历JSON树，对表格相关元素进行一次性、全面的处理和修复。
 * 1. 对于 <table>: 
 *    - 检查并自动包裹缺少 <tbody> 的子元素。
 *    - 将 cellspacing 和 cellpadding 属性转换为 CSS-in-JS 格式的 style 对象，并智能合并。
 * 2. 对于 <tr>: 
 *    - 检查其直接子元素，如果子元素不是 <td> 或 <th>，则自动用一个隐藏的 <td> 将其包裹。
 * @param {any} node - JSON树中的当前节点（对象或数组）。
 */
function traverseAndProcessAllTableLogic(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(item => traverseAndProcessAllTableLogic(item));
        return;
    }

    // --- 1. 针对 <table> 节点的所有处理逻辑 ---
    if (node.tagName === 'table') {
        // --- 1a. 修复缺失的 <tbody> ---
        const hasChildren = node.children && Array.isArray(node.children) && node.children.length > 0;
        if (hasChildren) {
            const needsTbody = node.children[0].tagName !== 'tbody';
            if (needsTbody) {
                console.log("发现一个 <table> 缺少 <tbody>，正在包裹其子元素...");
                const originalChildren = node.children;
                const tbodyElement = {
                    tagName: 'tbody',
                    children: originalChildren
                };
                node.children = [tbodyElement];
            }
        }

        // --- 1b. 处理 cellspacing 和 cellpadding ---
        if (node.attributes) {
            const attributes = node.attributes;
            let styleObject = {};

            if (attributes.style) {
                if (typeof attributes.style === 'string') {
                    styleObject = parseCssStringToObject(attributes.style);
                } else if (typeof attributes.style === 'object') {
                    styleObject = { ...attributes.style };
                }
            }

            if (attributes.cellspacing) {
                console.log(`发现 cellspacing="${attributes.cellspacing}"，转换为 style 对象...`);
                styleObject.borderSpacing = `${attributes.cellspacing}px`;
                styleObject.borderCollapse = 'separate';
                delete attributes.cellspacing;
            }

            if (attributes.cellpadding) {
                console.log(`发现 cellpadding="${attributes.cellpadding}"，转换为子元素 td/th 的 style...`);
                const paddingValue = `${attributes.cellpadding}px`;

                const applyPaddingToCells = (currentNode) => {
                    if (!currentNode) return;
                    if (Array.isArray(currentNode)) {
                        currentNode.forEach(applyPaddingToCells);
                    } else if (typeof currentNode === 'object') {
                        if (currentNode.tagName === 'td' || currentNode.tagName === 'th') {
                            if (!currentNode.attributes) currentNode.attributes = {};
                            
                            let cellStyleObject = {};
                            if (currentNode.attributes.style && typeof currentNode.attributes.style === 'string') {
                                cellStyleObject = parseCssStringToObject(currentNode.attributes.style);
                            } else if (currentNode.attributes.style && typeof currentNode.attributes.style === 'object') {
                                cellStyleObject = { ...currentNode.attributes.style };
                            }
                            
                            cellStyleObject.padding = paddingValue;
                            currentNode.attributes.style = cellStyleObject;
                        }
                        if (currentNode.children) {
                            applyPaddingToCells(currentNode.children);
                        }
                    }
                };

                if (node.children) {
                    applyPaddingToCells(node.children);
                }
                delete attributes.cellpadding;
            }

            if (Object.keys(styleObject).length > 0) {
                attributes.style = styleObject;
            } else {
                delete attributes.style;
            }
        }
    }

    // --- 2. 针对 <tr> 节点的处理逻辑 ---
    else if (node.tagName === 'tr' && node.children && Array.isArray(node.children)) {
        const newChildren = [];
        node.children.forEach(child => {
            const isInvalidChild = !(child && typeof child === 'object' && (child.tagName === 'td' || child.tagName === 'th'));
            
            if (isInvalidChild) {
                console.log("在 <tr> 中发现无效的子元素，正在用隐藏的 <td> 包裹...");
                const wrapperTd = {
                    tagName: 'td',
                    attributes: { style: { display: 'none' } },
                    children: [child]
                };
                newChildren.push(wrapperTd);
            } else {
                newChildren.push(child);
            }
        });
        node.children = newChildren;
    }

    // --- 3. 对所有子节点进行递归调用 ---
    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndProcessAllTableLogic(child));
    }
}


/**
 * 递归地遍历JSON树，将 'condition' 字段中的 'session.getAttribute(KEY)'
 * 智能地替换为 'sessionStorage.getItem('KEY')'。
 * @param {any} node - JSON树中的当前节点（对象或数组）。
 */
function traverseAndReplaceSessionGetAttribute(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(item => traverseAndReplaceSessionGetAttribute(item));
        return;
    }

    if (typeof node.condition === 'string' && node.condition.includes('session.getAttribute')) {
        console.log(`发现 condition 字段: "${node.condition}"，正在转换...`);
        const regex = /session\.getAttribute\((.*?)\)/g;
        
        node.condition = node.condition.replace(regex, (match, capturedArg) => {
            let key = capturedArg.trim();
            if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
                key = key.substring(1, key.length - 1);
            }
            return `sessionStorage.getItem('${key}')`;
        });

        console.log(`转换后: "${node.condition}"`);
    }

    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndReplaceSessionGetAttribute(child));
    }
}

/**
 * 根据指定规则递归处理 JSON 元素数组。
 * 1. 移除 tagName 为 'meta', 'title', 'link', 'script', 'noscript', 'style' 的节点。
 * 2. 对于 tagName 为 'html', 'head', 'body' 的节点，不包含节点本身，而是直接处理其 children。
 * 3. 递归处理所有子节点。
 * @param {Array} elements - 需要处理的元素节点数组。
 * @returns {Array} - 处理后生成的新元素数组。
 */
function processJsonElements(elements) {
  if (!Array.isArray(elements)) return [];

  return elements.reduce((accumulator, currentElement) => {
    const tagsToRemove = ['meta', 'title', 'link', 'script', 'noscript','style'];
    if (tagsToRemove.includes(currentElement.tagName)) {
      return accumulator;
    }

    const tagsToUnwrap = ['html', 'head', 'body'];
    if (tagsToUnwrap.includes(currentElement.tagName)) {
      const children = currentElement.children || [];
      return accumulator.concat(processJsonElements(children));
    }
    
    if (currentElement.children && currentElement.children.length > 0) {
      const newElement = { ...currentElement };
      newElement.children = processJsonElements(currentElement.children);
      accumulator.push(newElement);
    } else {
      accumulator.push(currentElement);
    }

    return accumulator;
  }, []);
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

            // --- 运行所有的后处理函数 ---

            // 1. 处理 <object> 标签
            traverseAndTransformObjects(parsedJson.elements);
            
            // 2. 处理 session.getAttribute
            traverseAndReplaceSessionGetAttribute(parsedJson.elements);

            // 3. (新) 对所有表格问题进行一次性、全面的修复
            console.log("正在对表格进行 tbody、样式和 tr 结构的全面修复...");
            traverseAndProcessAllTableLogic(parsedJson.elements);
            
            // 4. (最终) 应用节点过滤和结构扁平化规则
            console.log("正在应用最终的节点过滤和结构扁平化规则...");
            parsedJson.elements = processJsonElements(parsedJson.elements);

            return JSON.stringify(parsedJson, null, 2); // 成功

        } catch (error) {
            console.error(`Attempt ${attempt}/${maxAttempts} failed: Content is not valid JSON.`);

            if (attempt >= maxAttempts) {
                throw new Error("Failed to generate valid JSON after multiple attempts.");
            }

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
            currentContent = regeneratedContent;
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

        let toolCallsToProcess = responseMessage.tool_calls || [];
        if (toolCallsToProcess.length === 0 && responseMessage.content) {
            const normalizedCalls = await normalizeToolCallsWithLlm(responseMessage.content);
            if (normalizedCalls.length > 0) {
                toolCallsToProcess = normalizedCalls;
                responseMessage.tool_calls = normalizedCalls;
            }
        }

        sessions[sessionId].push(responseMessage);

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

            finalContent = await generateAndValidateJson(sessionId, integrationContent);

        } else {
            finalContent = await generateAndValidateJson(sessionId, responseMessage.content);
        }

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