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


// --- 工具函数 ---
/**
* 将 CSS 字符串解析为 JS 对象。
*/
function parseCssStringToObject(cssText) {
    if (typeof cssText !== 'string' || !cssText) return {};
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
* 如果值是纯数字，则自动加上 px 单位。
*/
const addPxIfNeeded = (value) => (/^[0-9]+$/.test(String(value)) ? `${value}px` : value);

// --- [最终版] 基于分阶段收敛法的严格顺序化规则 ---
/**
 * 规则被划分为多个阶段，引擎将按顺序处理每个阶段。
 * 在每个阶段内部，它会不断应用规则直到结构收敛（没有更多规则可应用），
 * 然后才会进入下一个阶段。
 */
const rulePhases = [
    // --- 阶段 1: 预处理 ---
    [
        {
            description: "[预处理] 转换 tagName 为小写",
            match: (node) => typeof node.tagName === 'string' &&
                node.tagName !== 'ConditionalBlock' && node.tagName !== 'LoopBlock' && // <-- 修改点: 增加此条件，防止 ConditionalBlock 被转为小写
                !node.isComponent &&
                node.tagName !== node.tagName.toLowerCase(),
            fix: (node) => { node.tagName = node.tagName.toLowerCase(); }
        }
    ],
    // --- 阶段 2: 表单位置处理 (优先完成所有表单相关的结构调整) ---
    [
        {
            description: "[表单提升] 将 <form> 从 <tr> 提升到 <tbody>",
            match: (node, parent) => node.tagName === 'form' && parent?.tagName === 'tr',
            fix: (node, parent) => {
                const tbody = parent.parent;
                if (tbody && ['tbody', 'thead', 'tfoot'].includes(tbody.tagName)) {
                    const trIndex = tbody.children.indexOf(parent);
                    if (trIndex > -1) {
                        // 从 <tr> 中移除 <form>
                        const formIndex = parent.children.indexOf(node);
                        if (formIndex > -1) parent.children.splice(formIndex, 1);
                        // 将 <form> 插入到 <tbody> 中，位于当前 <tr> 之后
                        tbody.children.splice(trIndex + 1, 0, node);
                    }
                }
            }
        },
        {
            description: "[表单提升] 将 <form> 从 <tbody> 提升到 <table>",
            match: (node, parent) => node.tagName === 'form' && parent?.tagName === 'tbody',
            fix: (node, parent) => {
                const table = parent.parent;
                if (table && table.tagName === 'table') {
                    const tbodyIndex = table.children.indexOf(parent);
                    if (tbodyIndex > -1) {
                        const formIndex = parent.children.indexOf(node);
                        if (formIndex > -1) parent.children.splice(formIndex, 1);
                        table.children.splice(tbodyIndex + 1, 0, node);
                    }
                }
            }
        },
        {
            description: "[表单重构] 拆分 <table> 内的 <form> 为 'form > table' 结构",
            match: (node) => node.tagName === 'table' && node.children?.some(child => child.tagName === 'form'),
            fix: (node, parent, root) => {
                const originalTable = node;
                const containerArray = parent ? parent.children : root.elements;
                const tableIndex = containerArray.indexOf(originalTable);
                if (tableIndex === -1) return;

                const finalElements = [];
                let nonFormContent = []; // 用于收集不属于任何 form 的内容

                // 将原 table 的子元素处理成独立的组
                originalTable.children.forEach(child => {
                    if (child.tagName === 'form') {
                        // 步骤 1: 如果在遇到 form 之前已经收集了其他内容，
                        // 先将这些内容打包成一个独立的 table。
                        if (nonFormContent.length > 0) {
                            finalElements.push({
                                tagName: 'table',
                                attributes: { ...originalTable.attributes },
                                children: nonFormContent
                            });
                            nonFormContent = []; // 清空收集器
                        }

                        // 步骤 2: 处理当前的 form，将其转换为 'form > table' 结构
                        const formChildren = child.children || [];
                        const newTableForForm = {
                            tagName: 'table',
                            attributes: { ...originalTable.attributes },
                            children: formChildren
                        };
                        child.children = [newTableForForm]; // 将新 table 放入 form
                        finalElements.push(child); // 将处理好的 form 放入最终列表

                    } else {
                        // 如果不是 form，就先收集起来
                        nonFormContent.push(child);
                    }
                });

                // 步骤 3: 处理循环结束后可能遗留的非 form 内容
                // (例如 table 的末尾有一些不在 form 内的 <tr>)
                if (nonFormContent.length > 0) {
                    finalElements.push({
                        tagName: 'table',
                        attributes: { ...originalTable.attributes },
                        children: nonFormContent
                    });
                }

                // 步骤 4: 用生成的新元素序列替换掉原来的 table
                if (finalElements.length > 0) {
                    containerArray.splice(tableIndex, 1, ...finalElements);
                }
            }
        }
    ],
    // --- 阶段 3: 表格语义与结构修复 (在表单结构稳定后进行) ---
    [
        {
            description: "[结构] 将 <table> 下的孤立节点移入 <tbody>",
            match: (node) => {
                if (node.tagName !== 'table' || !node.children || node.children.length === 0) {
                    return false;
                }
                const hasTbody = node.children.some(c => c.tagName === 'tbody');
                const hasOrphanNode = node.children.some(c => !['tbody', 'thead', 'tfoot', 'caption', 'colgroup'].includes(c.tagName));
                return hasTbody && hasOrphanNode;
            },
            fix: (node) => {
                const tbody = node.children.find(c => c.tagName === 'tbody');
                if (!tbody) return; // 理论上 match 条件保证了 tbody 存在

                const strayNodes = [];
                const sections = []; // 用于存放 tbody, thead 等合法部分

                // 1. 分离孤立节点和表格的标准部分
                node.children.forEach(child => {
                    if (['tbody', 'thead', 'tfoot', 'caption', 'colgroup'].includes(child.tagName)) {
                        sections.push(child);
                    } else {
                        strayNodes.push(child);
                    }
                });

                // 2. 将孤立节点移动到 tbody 的最前面
                if (strayNodes.length > 0) {
                    tbody.children.unshift(...strayNodes);
                }

                // 3. 更新 table 的子节点，只保留标准部分
                node.children = sections;
            }
        },
        {
            description: "[语义] <table> 缺少 <tbody>",
            match: (node) => node.tagName === 'table' && node.children?.length > 0 && node.children.every(c => c.tagName !== 'tbody'),
            fix: (node) => { node.children = [{ tagName: 'tbody', attributes: {}, children: node.children }]; }
        },
        {
            description: "[语义] <tbody> 下的非法子元素",
            match: (node, parent) => parent?.tagName === 'tbody' &&
                node.tagName !== 'tr' &&
                node.tagName !== 'ConditionalBlock', // <-- 修改点: 增加此条件，不处理 ConditionalBlock
            fix: (node, parent) => {
                const idx = parent.children.indexOf(node);
                if (idx !== -1) {
                    const wrapperTd = { tagName: 'td', attributes: {}, children: [node] };
                    const wrapperTr = { tagName: 'tr', attributes: {}, children: [wrapperTd] };
                    parent.children[idx] = wrapperTr;
                }
            }
        },
        {
            description: "[语义] <tr> 下的非法子元素",
            match: (node, parent) => parent?.tagName === 'tr' &&
                node.tagName !== 'td' &&
                node.tagName !== 'th' &&
                node.tagName !== 'ConditionalBlock', // <-- 修改点: 增加此条件，不处理 ConditionalBlock
            fix: (node, parent) => {
                const idx = parent.children.indexOf(node);
                if (idx !== -1) {
                    const wrapperTd = { tagName: 'td', attributes: {}, children: [node] };
                    parent.children[idx] = wrapperTd;
                }
            }
        },
        {
            description: "[结构] 修复 <tr> > ConditionalBlock 下的非法子元素",
            match: (node, parent) => {
                // 规则只对作为 <tr> 直接子元素的 ConditionalBlock 生效
                if (node.tagName !== 'ConditionalBlock' || parent?.tagName !== 'tr') {
                    return false;
                }

                // 检查它的任何一个分支中，是否包含需要修复的子节点
                if (Array.isArray(node.branches)) {
                    return node.branches.some(branch =>
                        Array.isArray(branch.children) &&
                        branch.children.some(child => child.tagName !== 'td' && child.tagName !== 'th')
                    );
                }
                return false;
            },
            fix: (node) => {
                // 遍历所有分支
                node.branches.forEach(branch => {
                    if (!branch.children || !Array.isArray(branch.children)) return;

                    // 创建一个新的子节点数组，用于存放修复后的节点
                    const newChildren = [];
                    branch.children.forEach(child => {
                        // 如果子节点本身是 td 或 th，则保持原样
                        if (child.tagName === 'td' || child.tagName === 'th') {
                            newChildren.push(child);
                        } else {
                            // 否则，创建一个新的 <td> 来包裹它
                            const wrapperTd = {
                                tagName: 'td',
                                attributes: {},
                                children: [child],
                                isComponent: false
                            };
                            newChildren.push(wrapperTd);
                        }
                    });
                    // 用修复后的新数组替换掉分支原来的 children 数组
                    branch.children = newChildren;
                });
            }
        },
        {
            description: "[孤立] 修复孤立的 <td> 或 <th>",
            match: (node, parent) => {
                if ((node.tagName === 'td' || node.tagName === 'th') && !node._wrapped) {
                    return parent?.tagName !== 'tr';
                }
                return false;
            },
            fix: (node, parent, root) => {
                node._wrapped = true; // 给 td/th 打标记
                const wrapperTr = { tagName: 'tr', attributes: {}, children: [node] };
                const wrapperTbody = { tagName: 'tbody', attributes: {}, children: [wrapperTr] };
                const wrapperTable = { tagName: 'table', attributes: {}, children: [wrapperTbody] };
                const container = parent ? parent.children : root.elements;
                const idx = container.indexOf(node);
                if (idx > -1) container[idx] = wrapperTable;
            }
        },
        {
            description: "[孤立] 修复孤立的 <tr>",
            match: (node, parent) => {
                if (node.tagName !== 'tr' || node._wrapped) return false;

                if (['tbody', 'thead', 'tfoot'].includes(parent?.tagName)) return false;
                if (parent && parent.condition !== undefined && parent.children && parent.parent?.tagName === 'ConditionalBlock') return false;
                if (parent?.tagName === 'ConditionalBlock' || parent?.tagName === 'LoopBlock') {
                    const grandParent = parent.parent;
                    if (['tbody', 'thead', 'tfoot'].includes(grandParent?.tagName)) return false;
                }
                if (parent?.condition && parent?.children && parent?.parent?.tagName === 'ConditionalBlock') {
                    const grandParent = parent.parent.parent;
                    if (['tbody', 'thead', 'tfoot'].includes(grandParent?.tagName)) return false;
                }
                return true;
            },
            fix: (node, parent, root) => {
                node._wrapped = true; // 给 tr 打标记
                const wrapperTbody = { tagName: 'tbody', attributes: {}, children: [node] };
                const wrapperTable = { tagName: 'table', attributes: {}, children: [wrapperTbody] };
                const container = parent ? parent.children : root.elements;
                const idx = container.indexOf(node);
                if (idx > -1) container[idx] = wrapperTable;
            }
        },
        {
            description: "[结构] 转换包裹 <form> 的 <p> 为带样式的 <div>",
            match: (node) => node.tagName === 'p' && node.children?.some(child => child.tagName === 'form'),
            fix: (node) => {
                // 1. 将 tagName 从 'p' 更改为 'div'
                node.tagName = 'div';

                // 2. 确保 attributes 和 style 对象存在
                if (!node.attributes) node.attributes = {};
                let style = {};
                if (typeof node.attributes.style === 'string') {
                    style = parseCssStringToObject(node.attributes.style);
                } else if (typeof node.attributes.style === 'object') {
                    style = { ...node.attributes.style };
                }

                // 3. 添加或覆盖 margin 属性以模拟 <p> 标签的默认垂直边距
                //    '1em 0' 是大多数浏览器对 <p> 标签的默认样式
                //    使用 `||` 可以避免覆盖已存在的 margin 设置
                style.margin = style.margin || '1em 0';

                // 4. 将更新后的 style 对象写回节点
                node.attributes.style = style;
            }
        }
    ],
    // --- [新增] 阶段 4: Struts 标签现代化转换 ---
    [
        {
            description: "[Struts Compatibility] 转换 html-tag 为 html:tag",
            match: (node) => typeof node.tagName === 'string' && node.tagName.startsWith('html-'),
            fix: (node) => {
                node.tagName = node.tagName.replace('html-', 'html:');
            }
        },
        {
            description: "[Struts] 转换 <html:form> 为 <form>",
            match: (node) => node.tagName === 'html:form',
            fix: (node) => {
                node.tagName = 'form';
                // action 属性通常 LLM 会保留，这里无需额外处理
            }
        },
        {
            description: "[Struts] 转换 <html:text> 为 <input type='text'>",
            match: (node) => node.tagName === 'html:text',
            fix: (node) => {
                node.tagName = 'input';
                if (!node.attributes) node.attributes = {};
                node.attributes.type = 'text';
                // 关键：将 Struts 的 property 映射到标准的 name 属性
                if (node.attributes.property) {
                    node.attributes.name = node.attributes.property;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:password> 为 <input type='password'>",
            match: (node) => node.tagName === 'html:password',
            fix: (node) => {
                node.tagName = 'input';
                if (!node.attributes) node.attributes = {};
                node.attributes.type = 'password';
                if (node.attributes.property) {
                    node.attributes.name = node.attributes.property;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:radio> 为 <label> 包裹的 <input type='radio'>",
            match: (node) => node.tagName === 'html:radio',
            fix: (node) => {
                const originalAttrs = node.attributes || {};
                let labelText = node.text || '';
                if (!labelText && node.children?.length > 0 && node.children[0].tagName === '#text') {
                    labelText = node.children[0].text;
                }
                const inputNode = {
                    tagName: 'input',
                    attributes: {
                        type: 'radio',
                        name: originalAttrs.property,
                        value: originalAttrs.value
                    },
                    children: []
                };
                const textNode = {
                    tagName: '#text',
                    text: ` ${labelText.trim()}`,
                    attributes: {},
                    children: []
                };
                node.tagName = 'label';
                node.children = [inputNode, textNode];
                delete originalAttrs.property;
                delete originalAttrs.value;
                delete node.text;
                node.attributes = originalAttrs;
            }
        },
        {
            description: "[Struts] 转换 <html:hidden> 为 <input type='hidden'>", // <-- 新增的规则
            match: (node) => node.tagName === 'html:hidden',
            fix: (node) => {
                node.tagName = 'input';
                if (!node.attributes) node.attributes = {};
                node.attributes.type = 'hidden';
                // 关键：将 Struts 的 property 映射到标准的 name 属性
                if (node.attributes.property) {
                    node.attributes.name = node.attributes.property;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:textarea> 为 <textarea>",
            match: (node) => node.tagName === 'html:textarea',
            fix: (node) => {
                node.tagName = 'textarea';
                if (!node.attributes) node.attributes = {};
                if (node.attributes.property) {
                    node.attributes.name = node.attributes.property;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:submit> 为 <button type='submit'>",
            match: (node) => node.tagName === 'html:submit',
            fix: (node) => {
                node.tagName = 'button';
                if (!node.attributes) node.attributes = {};
                node.attributes.type = 'submit';
                // 将 value 属性转换为按钮的文本内容，更符合现代实践
                if (node.attributes.value) {
                    node.children = [{ tagName: '#text', text: node.attributes.value, attributes: {}, children: [], isComponent: false }];
                    delete node.attributes.value;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:cancel> 为 <button type='reset'>", // <-- 新增的规则
            match: (node) => node.tagName === 'html:cancel',
            fix: (node) => {
                node.tagName = 'button';
                if (!node.attributes) node.attributes = {};
                node.attributes.type = 'reset';
                // 将 value 属性转换为按钮的文本内容
                if (node.attributes.value) {
                    node.children = [{ tagName: '#text', text: node.attributes.value, attributes: {}, children: [], isComponent: false }];
                    delete node.attributes.value;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:link> 为 <a>",
            match: (node) => node.tagName === 'html:link',
            fix: (node) => {
                node.tagName = 'a';
            }
        },
        {
            description: "[Struts] 转换 <html:errors /> 为带注释的占位符 <div>",
            match: (node) => node.tagName === 'html:errors',
            fix: (node) => {
                // 1. 将标签转换为 <div>
                node.tagName = 'div';
                node.isComponent = false; // 明确它是一个标准HTML元素

                // 2. 确保 attributes 对象存在
                if (!node.attributes) {
                    node.attributes = {};
                }

                // 3. 添加一个特定的类名，用于后续识别和样式化
                node.attributes.class = 'struts-errors-placeholder';

                // 4. 在内部添加注释文本，以解释其原始用途
                node.children = [
                    {
                        tagName: '#text',
                        text: ' Struts <html:errors /> placeholder ',
                        attributes: {},
                        children: [],
                        isComponent: false
                    }
                ];

                // 确保没有遗留的组件属性
                delete node.componentUrl;
            }
        },
        {
            description: "[Struts] 转换 <html:select> 为 <select>",
            match: (node) => node.tagName === 'html:select',
            fix: (node) => {
                node.tagName = 'select';
                if (!node.attributes) node.attributes = {};
                if (node.attributes.property) {
                    node.attributes.name = node.attributes.property;
                    delete node.attributes.property;
                }
            }
        },
        {
            description: "[Struts] 转换 <html:option> 为 <option>",
            match: (node) => node.tagName === 'html:option',
            fix: (node) => {
                node.tagName = 'option';
                if (!node.attributes) node.attributes = {};
                // 保留 value
                if (node.attributes.value) {
                    node.attributes.value = node.attributes.value;
                }
            }
        },
        {
            description: "[Struts] 转换 styleClass 属性为 class 属性",
            match: (node) => node.attributes && typeof node.attributes.styleClass !== 'undefined',
            fix: (node) => {
                // 如果 class 属性已存在，可以选择合并或覆盖
                // 这里采用覆盖的方式，因为 styleClass 通常是主要来源
                node.attributes.class = node.attributes.styleClass;
                delete node.attributes.styleClass;
            }
        },
        {
            description: "[Struts Logic] 转换 <logic:iterate> 为 LoopBlock",
            match: (node) => node.tagName === 'logic:iterate',
            fix: (node) => {
                node.tagName = 'LoopBlock';
                // 提取关键属性
                node.collection = node.attributes.name || node.attributes.property;
                node.item = node.attributes.id;
                // 清理已转换的属性
                if (node.attributes.name) delete node.attributes.name;
                if (node.attributes.property) delete node.attributes.property;
                if (node.attributes.id) delete node.attributes.id;
            }
        },
        {
            description: "[Struts Logic] 转换 <logic:present/notPresent> 为 ConditionalBlock",
            match: (node) => ['logic:present', 'logic:notpresent'].includes(node.tagName),
            fix: (node) => {
                const varName = node.attributes.name || node.attributes.property;
                const condition = node.tagName === 'logic:notpresent'
                    ? `!isPresent(${varName})`
                    : `isPresent(${varName})`;

                node.tagName = 'ConditionalBlock';
                node.condition = condition;

                // 清理属性
                if (node.attributes.name) delete node.attributes.name;
                if (node.attributes.property) delete node.attributes.property;
            }
        },
        {
            description: "[Struts Logic] 转换比较类 logic 标签为 ConditionalBlock",
            match: (node) => {
                const comparisonTags = [
                    'logic:equal', 'logic:notequal', 'logic:lessthan',
                    'logic:lessorequal', 'logic:greaterthan', 'logic:greaterorequal'
                ];
                return comparisonTags.includes(node.tagName);
            },
            fix: (node) => {
                const operators = {
                    'logic:equal': '==', 'logic:notequal': '!=',
                    'logic:lessthan': '<', 'logic:lessorequal': '<=',
                    'logic:greaterthan': '>', 'logic:greaterorequal': '>='
                };
                const attrs = node.attributes;
                const operator = operators[node.tagName];

                let leftHandSide;
                // **修正点**: 优先检查 'parameter'，然后才是 'name'/'property'
                if (attrs.parameter) {
                    leftHandSide = `params.${attrs.parameter}`;
                } else if (attrs.name) {
                    leftHandSide = attrs.name + (attrs.property ? `.${attrs.property}` : '');
                } else {
                    leftHandSide = 'UNDEFINED_VARIABLE'; // 兜底处理
                }

                const value = `'${attrs.value}'`;

                node.tagName = 'ConditionalBlock';
                node.condition = `${leftHandSide} ${operator} ${value}`;

                // 清理所有已处理的属性
                delete attrs.name;
                delete attrs.property;
                delete attrs.parameter;
                delete attrs.value;
            }
        }
    ],
    // --- [新增] 阶段 5: JSP 表达式现代化 ---
    [
        {
            description: "[JSP通用] 标准化属性中的动态上下文路径",
            match: (node) => {
                if (!node.attributes) return false;

                // 正则表达式，匹配以 <%=...%> 或 ${...} 开头的字符串
                const jspPathRegex = /^(<%=[\s\S]*?%>|\${[\s\S]*?})/;

                // 检查所有属性值是否符合该模式
                for (const key in node.attributes) {
                    const value = node.attributes[key];
                    if (typeof value === 'string' && jspPathRegex.test(value)) {
                        return true;
                    }
                }
                return false;
            },
            fix: (node) => {
                const jspPathRegex = /^(<%=[\s\S]*?%>|\${[\s\S]*?})/;

                for (const key in node.attributes) {
                    const value = node.attributes[key];
                    if (typeof value === 'string' && jspPathRegex.test(value)) {
                        // 移除表达式部分，并去除前后空格
                        let cleanedValue = value.replace(jspPathRegex, '').trim();

                        // 对于路径相关的属性 (src, href, action)，确保结果是根路径
                        if (['src', 'href', 'action'].includes(key.toLowerCase())) {
                            if (cleanedValue && !cleanedValue.startsWith('/')) {
                                cleanedValue = '/' + cleanedValue;
                            }
                        }

                        node.attributes[key] = cleanedValue;
                    }
                }
            }
        }
    ],
    // --- [新增] 阶段 6: 特定业务逻辑与组件化转换 ---
    [
        {
            description: "[Placeholder] 转换 <object> 为一个带样式的 <div> 占位符",
            match: (node) => node.tagName === 'object',
            fix: (node) => {
                // 1. 存储原始属性和参数
                const originalAttributes = { ...node.attributes };
                const params = [];
                if (node.children && Array.isArray(node.children)) {
                    node.children.forEach(child => {
                        if (child.tagName === 'param' && child.attributes?.name) {
                            params.push({ name: child.attributes.name, value: child.attributes.value || "" });
                        }
                    });
                }

                // 2. 构建可读的纯文本内容，而不是JSON
                let content = '[ActiveX Object Placeholder]\n\n';

                // 格式化 attributes
                content += 'ATTRIBUTES:\n';
                delete originalAttributes.style; // 不显示 style 属性本身
                const attrKeys = Object.keys(originalAttributes);
                if (attrKeys.length > 0) {
                    attrKeys.forEach(key => {
                        content += `  - ${key}: "${originalAttributes[key]}"\n`;
                    });
                } else {
                    content += '  (none)\n';
                }

                // 格式化 params
                content += '\nPARAMS:\n';
                if (params.length > 0) {
                    params.forEach(param => {
                        content += `  - Name: "${param.name}", Value: "${param.value}"\n`;
                    });
                } else {
                    content += '  (none)\n';
                }

                // 3. 将节点转换为带样式的占位符 div
                node.tagName = 'div';
                node.isComponent = false;

                node.attributes = {
                    class: 'activex-object-placeholder',
                    style: {
                        border: '2px dashed #dc3545',
                        backgroundColor: '#f8f9fa',
                        padding: '15px',
                        margin: '10px 0',
                        fontFamily: 'Consolas, "Courier New", monospace',
                        fontSize: '14px',
                        color: '#212529',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        width: "300px",
                        height: "100px",
                        overflow: "auto"
                    }
                };

                // 4. 将子节点替换为包含纯文本内容的单个文本节点
                node.children = [{
                    tagName: '#text',
                    text: content,
                    attributes: {},
                    children: [],
                    isComponent: false
                }];
            }
        },
        {
            description: "[Logic] 转换 condition 字段中的 session.getAttribute 为 sessionStorage.getItem",
            match: (node) => typeof node.condition === 'string' && node.condition.includes('session.getAttribute'),
            fix: (node) => {
                const regex = /session\.getAttribute\((.*?)\)/g;
                node.condition = node.condition.replace(regex, (match, capturedArg) => {
                    let key = capturedArg.trim();
                    // 移除参数两侧可能存在的引号
                    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
                        key = key.substring(1, key.length - 1);
                    }
                    return `sessionStorage.getItem('${key}')`;
                });
            }
        }
    ],
    // --- 阶段 7: 通用修复与属性转换 (最后进行) ---
    [
        {
            description: "[最后] 转换展示性属性为 style",
            match: (node) => node.attributes && Object.keys(node.attributes).some(a => ['align', 'valign', 'bgcolor', 'background', 'width', 'height', 'border', 'nowrap', 'cellspacing', 'color', 'face', 'size'].includes(a)),
            fix: (node) => {
                let style = {};
                if (typeof node.attributes.style === 'string') style = parseCssStringToObject(node.attributes.style);
                else if (typeof node.attributes.style === 'object') style = { ...node.attributes.style };

                const attrs = node.attributes;

                // 使用 typeof 检查属性是否存在，而不是检查其值
                if (typeof attrs.align !== 'undefined') { style.textAlign = attrs.align; delete attrs.align; }
                if (typeof attrs.valign !== 'undefined') { style.verticalAlign = attrs.valign; delete attrs.valign; }
                if (typeof attrs.bgcolor !== 'undefined') { style.backgroundColor = attrs.bgcolor; delete attrs.bgcolor; }
                if (typeof attrs.background !== 'undefined') { style.backgroundImage = `url(${attrs.background})`; delete attrs.background; }
                if (typeof attrs.width !== 'undefined') { style.width = addPxIfNeeded(attrs.width); delete attrs.width; }
                if (typeof attrs.height !== 'undefined') { style.height = addPxIfNeeded(attrs.height); delete attrs.height; }
                if (typeof attrs.border !== 'undefined') { style.border = attrs.border === '0' ? 'none' : `${addPxIfNeeded(attrs.border)} solid black`; delete attrs.border; }
                if (typeof attrs.nowrap !== 'undefined') { style.whiteSpace = 'nowrap'; delete attrs.nowrap; }
                if (typeof attrs.cellspacing !== 'undefined') { style.borderSpacing = addPxIfNeeded(attrs.cellspacing); style.borderCollapse = 'separate'; delete attrs.cellspacing; }
                if (typeof attrs.color !== 'undefined') { style.color = attrs.color; delete attrs.color; }
                if (typeof attrs.face !== 'undefined') { style.fontFamily = attrs.face; delete attrs.face; }
                if (typeof attrs.size !== 'undefined') { style.fontSize = addPxIfNeeded(attrs.size); delete attrs.size; }

                node.attributes.style = style;
            }
        },
        // 在 rulePhases 的最后一个阶段（阶段 7）中，使用此最终修正版规则
        {
            description: "[通用] 标准化src和href路径，移除动态前缀 (防死循环版)",
            match: (node) => {
                if (!node.attributes) {
                    return false;
                }

                // 定义一个内部辅助函数，用于判断路径是否已经符合最终规范
                const isPathNormalized = (path) => {
                    // 如果路径不是字符串或为空，则认为它无需处理（已规范）
                    if (typeof path !== 'string' || !path) {
                        return true;
                    }

                    // 规范1: 如果是完整的URL或特殊协议，则视为已规范
                    const absoluteUrlRegex = /^(https?:\/\/|data:|mailto:|tel:|\/\/)/i;
                    if (absoluteUrlRegex.test(path)) {
                        return true;
                    }

                    // 规范2: 如果路径以'/'开头，并且不包含任何动态占位符前缀，则视为已规范
                    const hasDynamicPrefix = /(^<%=[\s\S]*?%>|^\${[\s\S]*?}|^\{[^\}]+\})/.test(path);
                    if (path.startsWith('/') && !hasDynamicPrefix) {
                        return true;
                    }

                    // 其他所有情况都认为“未规范”，需要修复
                    return false;
                };

                // 关键：当且仅当 src 或 href 属性存在且“未规范”时，才返回 true
                if (node.attributes.src && !isPathNormalized(node.attributes.src)) {
                    return true;
                }
                if (node.attributes.href && !isPathNormalized(node.attributes.href)) {
                    return true;
                }

                return false;
            },
            fix: (node) => {
                // fix 函数中的 normalizePath 逻辑保持不变，因为它本身是正确的
                const normalizePath = (path) => {
                    if (!path) return path;

                    const absoluteUrlRegex = /^(https?:\/\/|data:|mailto:|tel:|\/\/)/i;
                    if (absoluteUrlRegex.test(path)) {
                        return path;
                    }

                    let cleanedPath = path.replace(/(^<%=[\s\S]*?%>|^\${[\s\S]*?}|^\{[^\}]+\})\/?/g, '');
                    cleanedPath = cleanedPath.replace(/\/+/g, '/');

                    if (!cleanedPath.startsWith('/')) {
                        cleanedPath = '/' + cleanedPath;
                    }
                    return cleanedPath;
                };

                // 分别处理需要修复的属性
                if (node.attributes.src) {
                    node.attributes.src = normalizePath(node.attributes.src);
                }
                if (node.attributes.href) {
                    node.attributes.href = normalizePath(node.attributes.href);
                }
            }
        },
        {
            description: "[清理] 删除内容为空的 ConditionalBlock",
            match: (node) => {
                if (node.tagName !== 'ConditionalBlock' || !Array.isArray(node.branches)) {
                    return false;
                }
                // 一个 ConditionalBlock 如果其所有分支都没有子节点，则被视为空。
                return node.branches.every(branch => !branch.children || branch.children.length === 0);
            },
            fix: (node, parent, root) => {
                // 确定要从哪个数组中移除此节点。
                // 如果 `parent` 为 null，则说明这是一个位于 root.elements 中的顶级元素。
                const container = parent ? parent.children : root.elements;
                if (container) {
                    const index = container.indexOf(node);
                    if (index > -1) {
                        container.splice(index, 1);
                    }
                }
            }
        }
    ]
];


/**
 * 递归遍历树，为每个节点添加一个指向其父节点的不可枚举的引用。
 */
/**
 * [修复后] 递归遍历树（或节点数组），为每个节点添加一个指向其父节点的不可枚举的引用。
 * 能正确处理根节点为数组的情况。
 */
function addParentLinks(nodeOrArray, parent = null) {
    // 新增：如果输入是一个数组，则遍历数组中的每个节点
    if (Array.isArray(nodeOrArray)) {
        for (const childNode of nodeOrArray) {
            // 对数组中的每个元素进行递归调用
            // 它们的父节点是调用时传入的 parent (对于根数组，parent 是 null)
            addParentLinks(childNode, parent);
        }
        return; // 处理完数组后直接返回
    }

    // --- 以下为原逻辑，保持不变 ---

    // 如果输入是单个节点对象
    const node = nodeOrArray;
    if (!node || typeof node !== 'object') return;

    // 为当前节点定义不可枚举的 'parent' 属性
    Object.defineProperty(node, 'parent', {
        value: parent,
        writable: true,
        configurable: true,
        enumerable: false
    });

    // 如果节点有子节点，则递归处理子节点数组
    if (node.children && Array.isArray(node.children)) {
        // 此时，当前节点 'node' 就是它所有子节点的父节点
        addParentLinks(node.children, node);
    }
}

/**
 * [修正版] 深度优先遍历，查找并应用第一个匹配的规则。
 * @param {object|array} nodeOrArray - 当前要检查的节点或节点数组。
 * @param {object} parent - 父节点。
 * @param {object} root - 整个 JSON 树的根对象。
 * @param {array} rulesToApply - 本次检查要应用的规则数组。
 * @returns {boolean} - 如果应用了规则则返回 true，否则返回 false。
 */
function applyOneRule(nodeOrArray, parent, root, rulesToApply) {
    if (!nodeOrArray || typeof nodeOrArray !== 'object') return false;

    // Case 1: 节点是一个节点数组 (e.g., children or root.elements)
    if (Array.isArray(nodeOrArray)) {
        for (const item of nodeOrArray) {
            if (applyOneRule(item, parent, root, rulesToApply)) {
                return true; // 发现并修复了一个问题，立即停止并返回
            }
        }
        return false;
    }

    // Case 2: 节点是一个对象
    const node = nodeOrArray;

    // 首先，对当前节点尝试所有规则
    for (const rule of rulesToApply) {
        if (rule.match(node, node.parent, root)) {
            console.log(`应用规则: ${rule.description}`);
            rule.fix(node, node.parent, root);
            return true; // 修复完成，立即返回 true
        }
    }

    // 如果当前节点没有匹配的规则，则递归检查其子孙节点
    
    // --- [核心修正点] ---
    // 特殊处理 ConditionalBlock，确保其分支本身和分支的子节点都被检查
    if (node.tagName === 'ConditionalBlock' && Array.isArray(node.branches)) {
        for (const branch of node.branches) {
            // 步骤 1: 将 branch 对象自身视为一个节点进行规则匹配
            // 这对于需要检查 branch 上 'condition' 属性的规则至关重要
            for (const rule of rulesToApply) {
                // 注意：branch 对象的父级是 ConditionalBlock 节点 (node)
                if (rule.match(branch, node, root)) {
                    console.log(`在 Conditional Branch 上应用规则: ${rule.description}`);
                    rule.fix(branch, node, root);
                    return true; // 规则已应用，立即返回 true 以重新开始收敛过程
                }
            }

            // 步骤 2: 如果 branch 自身没有匹配，则递归检查其 children
            if (branch.children && applyOneRule(branch.children, branch, root, rulesToApply)) {
                return true; // 子节点中应用了规则，向上传递 true
            }
        }
    }
    // --- [修正结束] ---

    // 对于标准节点，递归检查其子节点
    if (node.children && Array.isArray(node.children)) {
        if (applyOneRule(node.children, node, root, rulesToApply)) {
            return true; // 子节点中应用了规则，向上传递 true
        }
    }

    return false; // 当前节点及其所有子节点都没有匹配任何规则
}


/**
* 过滤掉不需要的标签，并展开 html/head/body。
*/
function processJsonElements(elements) {
    if (!Array.isArray(elements)) return [];
    return elements.reduce((acc, el) => {
        const tagsToRemove = ['meta', 'title', 'link', 'script', 'noscript', 'style', '!doctype'];
        if (!el.tagName || tagsToRemove.includes(el.tagName.toLowerCase())) return acc;

        const tagsToUnwrap = ['html', 'head', 'body'];
        if (tagsToUnwrap.includes(el.tagName.toLowerCase())) {
            return acc.concat(processJsonElements(el.children || []));
        }

        // --- 新增修复逻辑 ---
        if (el.tagName === 'ConditionalBlock' && Array.isArray(el.branches)) {
            // 遍历所有分支，并对每个分支的 children 进行递归处理
            const newBranches = el.branches.map(branch => ({
                ...branch,
                children: processJsonElements(branch.children || [])
            }));
            const newEl = { ...el, branches: newBranches };
            acc.push(newEl);
        } else if (el.children && el.children.length > 0) { // 原有逻辑
            const newEl = { ...el, children: processJsonElements(el.children) };
            acc.push(newEl);
        } else {
            acc.push(el);
        }
        return acc;
    }, []);
}

/**
* [修改后] 确保 LLM 生成的内容是合法 JSON，并应用多遍分阶段修复规则直至收敛。
*/
async function generateAndValidateJson(sessionId, initialContent) {
    // 定义一个内部函数，用于从可能包含 Markdown 标记的字符串中提取纯 JSON 文本。
    const extractJsonFromString = (text) => {
        // 如果输入不是字符串（例如 null 或 undefined），返回一个空的 JSON 对象字符串以避免后续错误。
        if (typeof text !== 'string') {
            return '{}';
        }

        // 使用正则表达式匹配 ```json ... ``` 或 ``` ... ``` 代码块。
        // [\s\S]*? 能够匹配包括换行符在内的任何字符（非贪婪模式）。
        const regex = /```(?:json)?\s*([\s\S]*?)\s*```/;
        const match = text.match(regex);

        // 如果匹配成功，返回捕获组（即代码块内的内容），并去除首尾空格。
        if (match && match[1]) {
            return match[1].trim();
        }

        // 如果没有找到 Markdown 代码块，直接返回原始文本并去除首尾空格。
        // 这可以处理模型直接返回纯 JSON 字符串的情况。
        return text.trim();
    };
    let currentContent = extractJsonFromString(initialContent);;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            let parsedJson = JSON.parse(currentContent);
            console.log(`Attempt ${attempt}: JSON is valid.`);

            // --- [新] 分阶段收敛修复引擎 ---
            const maxPassesPerPhase = 1000;
            console.log("启动分阶段收敛修复引擎...");

            // 遍历每一个规则阶段
            for (const [phaseIndex, currentPhaseRules] of rulePhases.entries()) {
                let pass = 0;
                let ruleWasApplied;

                console.log(`--- 进入阶段 ${phaseIndex + 1} ---`);

                // 在每个阶段内部进行收敛循环
                do {
                    pass++;
                    // 每一遍开始时，都必须重新计算和链接所有父节点
                    addParentLinks(parsedJson.elements, null);

                    // 在当前阶段的规则中应用单个规则
                    ruleWasApplied = applyOneRule(parsedJson.elements, null, parsedJson, currentPhaseRules);

                } while (ruleWasApplied && pass < maxPassesPerPhase);

                console.log(`阶段 ${phaseIndex + 1} 结束于第 ${pass} 遍。`);
                if (pass >= maxPassesPerPhase) {
                    console.warn(`阶段 ${phaseIndex + 1} 达到最大处理遍数，可能存在规则冲突或死循环。`);
                }
            }
            // --- 引擎结束 ---

            console.log("应用最终过滤...");
            parsedJson.elements = processJsonElements(parsedJson.elements);

            return JSON.stringify(parsedJson, null, 2);

        } catch (error) {
            console.error(`Attempt ${attempt}/${maxAttempts} failed: invalid JSON.`, error);
            if (attempt >= maxAttempts) throw new Error("Failed to generate valid JSON after multiple attempts.");

            // JSON 无效时的重试逻辑 (保持不变)
            sessions[sessionId].push({ role: "assistant", content: currentContent });
            sessions[sessionId].push({ role: "user", content: "整合结果错误，JSON格式不正确，请严格按照JSON格式重新整合并输出。" });
            const stream = await openai.chat.completions.create({ /* ... */ });
            let regenerated = "";
            for await (const chunk of stream) regenerated += chunk.choices[0]?.delta?.content || "";
            currentContent = regenerated;
        }
    }
}


// --- API 路由 (保持不变) ---
router.post('/chat', async (req, res) => {
    try {
        const { message, sessionId = 'default' } = req.body;
        console.log("收到请求 sessionId:", sessionId);

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        initializeSession(sessionId, `你是一位精通将旧版 JSP/Struts 代码转换为现代化 JSON 结构的 AI 专家。你的核心任务是将用户提供的代码片段，严格按照下面提供的 JSON Schema 格式，转换成一个唯一的、完整的、合法的 JSON 对象。

### 核心要求：输出格式必须严格遵守以下 JSON Schema
\`\`\`json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "JSP Page Structure Schema (with ConditionalBlock and LoopBlock)",
  "description": "一个用于描述已解析的 JSP 页面结构的 JSON Schema，支持使用 ConditionalBlock 处理条件逻辑和 LoopBlock 处理循环逻辑。",
  "type": "object",
  "properties": {
    "variable": {
        "type": "object",
        "description": "存储页面中定义的变量及其类型",
        "additionalProperties": {
            "type": "string",
            "enum": ["string", "number", "boolean", "object", "null", "undefined"]
        }
    },
    "links": { "type": "array", "items": { "type": "string", "format": "uri-reference" } },
    "style": {
        "type": "object",
        "description": "CSS选择器作为键，样式对象作为值。",
        "additionalProperties": {
            "type": "object",
            "description": "CSS属性作为键，值作为字符串。",
            "additionalProperties": { "type": "string" }
        }
    },
    "elements": { "type": "array", "items": { "$ref": "#/definitions/element" } }
  },
  "required": [ "variable", "links", "style", "elements" ],
  "definitions": {
    "element": {
      "oneOf": [
        { "$ref": "#/definitions/standardNode" },
        { "$ref": "#/definitions/conditionalBlockNode" },
        { "$ref": "#/definitions/loopBlockNode" }
      ]
    },
    "standardNode": {
      "type": "object",
      "properties": {
        "tagName": { "type": "string", "not": { "enum": ["ConditionalBlock", "LoopBlock"] } },
        "text": { "type": "string" },
        "attributes": {
          "type": "object",
          "properties": { "style": { "type": "object", "additionalProperties": { "type": "string" } } },
          "additionalProperties": { "type": "string" }
        },
        "condition": { "type": "string" },
        "children": { "type": "array", "items": { "$ref": "#/definitions/element" } },
        "isComponent": { "type": "boolean", "default": false },
        "componentUrl": { "type": "string", "format": "uri-reference" }
      },
      "required": [ "tagName", "attributes", "children", "isComponent" ]
    },
    "conditionalBlockNode": {
      "type": "object",
      "properties": {
        "tagName": { "const": "ConditionalBlock" },
        "branches": { "type": "array", "minItems": 1, "items": { "$ref": "#/definitions/branch" } }
      },
      "required": [ "tagName", "branches" ]
    },
    "branch": {
      "type": "object",
      "properties": {
        "condition": { "type": "string" },
        "children": { "type": "array", "items": { "$ref": "#/definitions/element" } }
      },
      "required": [ "condition", "children" ]
    },
    "loopBlockNode": {
      "type": "object",
      "properties": {
        "tagName": { "const": "LoopBlock" },
        "collection": { "type": "string" },
        "item": { "type": "string" },
        "children": { "type": "array", "items": { "$ref": "#/definitions/element" } }
      },
      "required": [ "tagName", "collection", "item", "children" ]
    }
  }
}
\`\`\`

### 关键结构说明
1.  **顶层结构**: 最终输出必须是包含 \`variable\`, \`links\`, \`style\`, \`elements\` 四个键的根对象。
2.  **条件逻辑 (ConditionalBlock)**: 任何 if/else 逻辑（如 \`<logic:present>\`, \`<c:if>\`）都必须转换为 \`ConditionalBlock\` 结构。
    -   \`tagName\` 固定为 \`"ConditionalBlock"\`。
    -   包含一个 \`branches\` 数组，数组中每个对象代表一个分支 (\`if\`, \`else if\`, \`else\`)。
    -   每个分支都有 \`condition\` 字符串和 \`children\` 数组。
    -   **\`else\` 分支的 \`condition\` 必须是字符串 \`'true'\`**。

3.  **循环逻辑 (LoopBlock)**: 任何用于生成重复元素的循环（如 Struts 的 \`<logic:iterate>\`、JSTL 的 \`<c:forEach>\`，**特别是原生 JSP 的 \`for\` 或 \`while\` 循环**）都必须转换为 \`LoopBlock\` 结构。
    -   \`tagName\` 固定为 \`"LoopBlock"\`。
    -   \`collection\`: 循环的数据源名称（通常是一个变量名，例如 "departments"）。
    -   \`item\`: 每次循环中单个元素的变量名（例如 "department"）。
    -   \`children\`: 循环体内重复生成的元素结构。
    -   **JSP \`while\` 循环示例**:
        **原始 JSP 代码:**
        \`\`\`jsp
        <html:select property="deptCode">
          <html:option value="">[Please Select]</html:option>
          <%
          Iterator dep = UDepartment.getIterator();
          while( dep.hasNext() ) {
              UDepartment department = (UDepartment)dep.next();
              String code = department.getCode();
              String desc = department.getDescription();
          %>
            <html:option value="<%=code%>"><%=desc%></html:option>
          <%} %>
        </html:select>
        \`\`\`

        **必须转换成的 JSON 结构:**
        \`\`\`json
        {
          "tagName": "select",
          "attributes": { "name": "deptCode" },
          "children": [
            {
              "tagName": "option",
              "attributes": { "value": "" },
              "isComponent": false,
              "children": [{ "tagName": "#text", "text": "[Please Select]", "attributes": {}, "children": [], "isComponent": false }]
            },
            {
              "tagName": "LoopBlock",
              "collection": "departments",
              "item": "department",
              "children": [
                {
                  "tagName": "option",
                  "isComponent": false,
                  "attributes": {
                    "value": "{department.code}"
                  },
                  "children": [
                    { "tagName": "#text", "text": "{department.description}", "attributes": {}, "children": [], "isComponent": false }
                  ]
                }
              ]
            }
          ]
        }
        \`\`\`

4.  **样式 (style)**: 在 \`attributes\` 对象中，\`style\` 键的值 **必须是一个 CSS 键值对的 JSON 对象**，绝不能是字符串。
5.  **文本节点**: 独立的文本内容应表示为 \`{ "tagName": "#text", "text": "你的文本内容" }\`。

### 工具使用规则
- **样式修复 (\`normalizeStyleWithLlm\`)**: 当遇到字符串形式或不规范的 \`style\` 属性时，必须优先调用此工具。
- **片段转换 (\`convertJspSnippet\`)**: 当遇到无法直接转换的小型、独立的自定义标签（如 \`<jsp:include>\`, \`<c:if>\` 等）时，必须调用此工具。
- **\`html:xx\` 标签**: 对于所有 \`html:xx\` 格式的标签，请将它们当作普通标签初步处理，后续的自动化规则会进行转换。
`);

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

// 会话管理 (保持不变)
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

export default router;