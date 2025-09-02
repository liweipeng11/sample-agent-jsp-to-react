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
        node.forEach(item => traverseAndTransformObjects(item));
        return;
    }

    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndTransformObjects(child));
    }

    if (node.tagName === 'object') {
        console.log("发现一个 <object> 标签，正在转换为 ActiveXPlaceholder...");
        const params = {};
        if (node.children && Array.isArray(node.children)) {
            node.children.forEach(child => {
                if (child.tagName === 'param' && child.attributes) {
                    const name = child.attributes.name;
                    const value = child.attributes.value;
                    if (name) {
                        params[name] = value || "";
                    }
                }
            });
        }
        node.tagName = 'ActiveXPlaceholder';
        node.isComponent = true;
        node.children = [{ "params": params }];
    }
}

/**
 * 辅助函数：将CSS字符串解析为CSS-in-JS对象。
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

// --- (新增) 属性到样式的转换 ---

/**
 * 辅助函数：如果值是纯数字，则为其添加 'px' 单位。
 * @param {string} value - 属性值。
 * @returns {string} - 处理后的值。
 */
const addPxIfNeeded = (value) => {
    if (String(value).match(/^[0-9]+$/)) {
        return `${value}px`;
    }
    return value;
};

/**
 * 定义一个从废弃的HTML属性到CSS-in-JS样式的映射。
 * 每个键是HTML属性名，值是一个描述如何转换的对象。
 * - cssProperty: 对应的CSS属性名。
 * - valueMap: (可选) 用于直接映射特定值的对象。
 * - handler: (可选) 一个自定义函数，用于更复杂的转换逻辑。
 */
const attributeToStyleMap = {
    'align': { cssProperty: 'textAlign' },
    'valign': { cssProperty: 'verticalAlign' },
    'bgcolor': { cssProperty: 'backgroundColor' },
    'background': { cssProperty: 'backgroundImage', handler: (value) => `url(${value})` },
    'width': { cssProperty: 'width', handler: addPxIfNeeded },
    'height': { cssProperty: 'height', handler: addPxIfNeeded },
    'border': {
        cssProperty: 'border',
        handler: (value) => (value === '0' ? 'none' : `${addPxIfNeeded(value)} solid black`)
    },
    'nowrap': { cssProperty: 'whiteSpace', fixedValue: 'nowrap' },
    'cellspacing': {
        handler: (value, style) => {
            style.borderSpacing = addPxIfNeeded(value);
            style.borderCollapse = 'separate';
        }
    },
    // color、face、size 属性常用于 <font> 标签，但也可以在此处通用处理
    'color': { cssProperty: 'color' },
    'face': { cssProperty: 'fontFamily' },
    'size': { cssProperty: 'fontSize', handler: addPxIfNeeded } // 简单处理，实际的 size 映射更复杂
};

/**
 * (新) 递归遍历JSON树，将所有废弃的展示性属性转换为CSS-in-JS的 style 对象。
 * @param {any} node - JSON树中的当前节点。
 */
function traverseAndApplyPresentationalAttributes(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(item => traverseAndApplyPresentationalAttributes(item));
        return;
    }

    if (node.attributes) {
        let styleObject = {};
        // 确保与现有的 style 属性合并
        if (node.attributes.style) {
            if (typeof node.attributes.style === 'string') {
                styleObject = parseCssStringToObject(node.attributes.style);
            } else if (typeof node.attributes.style === 'object') {
                styleObject = { ...node.attributes.style };
            }
        }

        const attributesToDelete = [];

        for (const attrName in node.attributes) {
            if (attributeToStyleMap[attrName]) {
                const mapping = attributeToStyleMap[attrName];
                const attrValue = node.attributes[attrName];

                console.log(`发现属性 ${attrName}="${attrValue}"，正在转换为 style...`);

                if (mapping.handler) {
                    // 自定义处理器可能直接修改 styleObject
                    mapping.handler(attrValue, styleObject);
                } else {
                    let finalValue = attrValue;
                    if (mapping.fixedValue) {
                        finalValue = mapping.fixedValue;
                    } else if (mapping.valueMap && mapping.valueMap[attrValue]) {
                        finalValue = mapping.valueMap[attrValue];
                    }
                    styleObject[mapping.cssProperty] = finalValue;
                }

                attributesToDelete.push(attrName);
            }
        }

        // 清理已转换的属性
        attributesToDelete.forEach(attr => delete node.attributes[attr]);

        // 更新 style 属性
        if (Object.keys(styleObject).length > 0) {
            node.attributes.style = styleObject;
        } else {
            // 如果 style 对象为空，则移除它
            delete node.attributes.style;
        }
    }

    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndApplyPresentationalAttributes(child));
    }
}


/**
 * (已重构) 递归地遍历JSON树，仅处理表格的 *结构性* 问题。
 * 1. 对于 <table>: 
 *    - 检查并自动包裹缺少 <tbody> 的子元素。
 *    - 将 cellpadding 属性转换为其子单元格的 padding 样式。
 * 2. 对于 <tr>: 
 *    - 检查其直接子元素，如果不是 <td> 或 <th>，则用隐藏的 <td> 包裹。
 * @param {any} node - JSON树中的当前节点。
 */
function traverseAndProcessTableStructure(node) {
    if (node === null || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(item => traverseAndProcessTableStructure(item));
        return;
    }

    if (node.tagName === 'table') {
        // 1a. 修复缺失的 <tbody>
        const hasChildren = node.children && Array.isArray(node.children) && node.children.length > 0;
        if (hasChildren && node.children[0].tagName !== 'tbody') {
            console.log("发现一个 <table> 缺少 <tbody>，正在包裹其子元素...");
            const tbodyElement = { tagName: 'tbody', children: node.children };
            node.children = [tbodyElement];
        }

        // 1b. 处理 cellpadding (因为它影响子元素，所以留在这里)
        if (node.attributes && node.attributes.cellpadding) {
            console.log(`发现 cellpadding="${node.attributes.cellpadding}"，转换为子元素 td/th 的 style...`);
            const paddingValue = addPxIfNeeded(node.attributes.cellpadding);

            const applyPaddingToCells = (currentNode) => {
                if (!currentNode) return;
                if (Array.isArray(currentNode)) {
                    currentNode.forEach(applyPaddingToCells);
                } else if (typeof currentNode === 'object') {
                    if (currentNode.tagName === 'td' || currentNode.tagName === 'th') {
                        if (!currentNode.attributes) currentNode.attributes = {};

                        let cellStyle = {};
                        if (currentNode.attributes.style && typeof currentNode.attributes.style === 'string') {
                            cellStyle = parseCssStringToObject(currentNode.attributes.style);
                        } else if (currentNode.attributes.style && typeof currentNode.attributes.style === 'object') {
                            cellStyle = { ...currentNode.attributes.style };
                        }

                        cellStyle.padding = paddingValue;
                        currentNode.attributes.style = cellStyle;
                    }
                    if (currentNode.children) {
                        applyPaddingToCells(currentNode.children);
                    }
                }
            };

            if (node.children) {
                applyPaddingToCells(node.children);
            }
            delete node.attributes.cellpadding;
        }
    } else if (node.tagName === 'tr' && node.children && Array.isArray(node.children)) {
        // 2. 修复 <tr> 的无效子元素
        node.children = node.children.map(child => {
            const isInvalid = !(child && typeof child === 'object' && (child.tagName === 'td' || child.tagName === 'th'));
            if (isInvalid) {
                console.log("在 <tr> 中发现无效的子元素，正在用隐藏的 <td> 包裹...");
                return {
                    tagName: 'td',
                    attributes: { style: { display: 'none' } },
                    children: [child]
                };
            }
            return child;
        });
    }

    if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverseAndProcessTableStructure(child));
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
        const tagsToRemove = ['meta', 'title', 'link', 'script', 'noscript', 'style'];
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

// --- 配置化规则表 ---
const nestingRules = [
    {
        match: (node, parent) => parent?.tagName === 'tr' && node.tagName === 'form',
        fix: (node, parent) => {
            console.log("修复: <tr> 下直接有 <form>");
            const wrapperTd = { tagName: 'td', attributes: {}, children: [node] };
            const idx = parent.children.indexOf(node);
            parent.children[idx] = wrapperTd;
        }
    },
    {
        match: (node, parent) => parent?.tagName === 'p' && node.tagName === 'form',
        fix: (node, parent) => {
            console.log("修复: <p> 下直接有 <form>");
            if (parent.parent) {
                const parentIndex = parent.parent.children.indexOf(parent);
                parent.parent.children.splice(parentIndex, 0, node);
                parent.children = parent.children.filter(c => c !== node);
            }
        }
    },
    {
        match: (node, parent) => parent?.tagName === 'table' && node.tagName === 'form',
        fix: (node, parent) => {
            console.log("修复: <table> 下直接有 <form>");
            if (parent.parent) {
                const idx = parent.parent.children.indexOf(parent);
                parent.parent.children[idx] = {
                    tagName: 'form',
                    attributes: {},
                    children: [parent]
                };
            }
        }
    },
    {
        match: (node, parent) => node.tagName === 'td' && (!parent || parent?.tagName !== 'tr'),
        fix: (node, parent, rootRef) => {
            console.log("修复: 孤立 <td>");
            const wrapperTr = { tagName: 'tr', attributes: {}, children: [node] };
            const wrapperTable = { tagName: 'table', attributes: {}, children: [wrapperTr] };
            if (parent) {
                const idx = parent.children.indexOf(node);
                parent.children[idx] = wrapperTable;
            } else {
                // parent 为 null，说明 node 在根级
                if (Array.isArray(rootRef.elements)) {
                    const idx = rootRef.elements.indexOf(node);
                    if (idx !== -1) {
                        rootRef.elements[idx] = wrapperTable;
                    }
                }
            }
        }
    }

];


// --- 统一的修复器 ---
function traverseAndFixInvalidNesting(node, parent = null, rootRef = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(child => traverseAndFixInvalidNesting(child, parent, rootRef));
    return;
  }

  for (const rule of nestingRules) {
    if (rule.match(node, parent)) {
      rule.fix(node, parent, rootRef);
    }
  }

  if (node.children && Array.isArray(node.children)) {
    node.children.forEach(child => traverseAndFixInvalidNesting(child, node, rootRef));
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

            // --- 运行所有的后处理函数 ---

            // 1. (新) 通用处理：将所有废弃的展示性属性转换为 style 对象
            traverseAndApplyPresentationalAttributes(parsedJson.elements);

            // 2. 特殊处理 <object> 标签
            traverseAndTransformObjects(parsedJson.elements);

            // 3. 特殊处理 session.getAttribute
            traverseAndReplaceSessionGetAttribute(parsedJson.elements);

            // 4. (重构) 仅处理表格的 *结构性* 问题
            traverseAndProcessTableStructure(parsedJson.elements);

            // 新增步骤: 修复不规范嵌套
            traverseAndFixInvalidNesting(parsedJson.elements, null, parsedJson);
            // 5. (最终) 应用节点过滤和结构扁平化规则
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