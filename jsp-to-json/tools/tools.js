import OpenAI from "openai";
import dotenv from 'dotenv';
dotenv.config();

// 初始化 OpenAI 客户端
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE
});

// --- 工具函数：解析 style 属性为对象 ---
function parseStyle(styleString) {
    if (!styleString) return {};
    return styleString.split(";").reduce((acc, decl) => {
        const [rawKey, rawValue] = decl.split(":");
        if (!rawKey || !rawValue) return acc;
        const key = rawKey.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        acc[key] = rawValue.trim();
        return acc;
    }, {});
}

// --- 【新增】: 专门处理 jsp:include ---
function convertJspInclude(snippet) {
    snippet = snippet.replace(/\\"/g, '"');
    const attrRegex = /(\w+)="([^"]*)"/g;
    const attributes = {};
    let match;
    let pageAttr = null;

    while ((match = attrRegex.exec(snippet)) !== null) {
        const name = match[1];
        const value = match[2];
        if (name === "page") {
            pageAttr = value;
        } else if (name === "style") {
            attributes.style = parseStyle(value);
        } else {
            attributes[name] = value;
        }
    }

    if (!pageAttr) {
        return JSON.stringify({ error: "jsp:include 缺少 page 属性" });
    }

    // 生成组件名（首字母大写，去掉扩展名）
    const fileName = pageAttr.split("/").pop().replace(/\.jsp$/i, "");
    const componentName = fileName.charAt(0).toUpperCase() + fileName.slice(1);

    // 生成 componentUrl
    let componentUrl;
    if (pageAttr.startsWith("/")) {
        const dir = pageAttr.split("/").slice(0, -1).join("/");
        componentUrl = `@/pages${dir}/${componentName}.jsx`;
    } else {
        componentUrl = `./${componentName}.jsx`;
    }

    return JSON.stringify({
        tagName: componentName,
        attributes,
        isComponent: true,
        componentUrl,
        children: []
    });
}

/**
 * 提示词注册表 (Prompt Registry)
 * --------------------------------
 * 这里是所有不同 JSP 标签转换规则的核心。
 * - 键 (Key): 标签的唯一标识符 (例如: "jsp:include", "c:if", "html")。
 * - 值 (Value): 一个包含 systemPrompt 和 userPromptTemplate 的对象。
 *
 * 要支持一个新的标签，你只需要在这里添加一个新的条目即可。
 */
const promptRegistry = {
    "jsp:include": {
        systemPrompt: `你是一个精通JSP到JSON转换的专家级程序员。你的任务是严格按照用户提供的规则，将JSP代码片段转换为指定的JSON对象，并且只输出纯粹的JSON结果。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的JSP代码片段精确地转换为指定的JSON格式。

**转换规则:**
1.  **tagName**:
    *   根据其 \`page\` 属性生成组件名（首字母大写）。
2.  **attributes**:
    *   将JSP标签的所有属性（**除了 \`page\` 属性**）转换为一个键值对，作为 \`attributes\` 对象的值。\`page\` 属性仅用于生成组件名和路径，不应出现在最终的 attributes 中。
    *   **特殊处理**: 如果属性名为 \`style\`，其值（例如 \`"color:red; font-size:14px"\`）必须被解析成一个CSS-in-JS风格的JSON对象（例如 \`{"color":"red", "fontSize":"14px"}\`）。
3.  **isComponent**: 始终为 \`true\`。
4.  **componentUrl (重要路径规则)**:
    *   其值由 \`page\` 属性的路径决定：
        *   如果 \`page\` 属性以 \`/\` 开头 (例如 \`page="/admin/user.jsp"\`)，则 URL 为 \`"@/pages"\` + \`page\` 属性的路径（去掉文件名） + 转换后的组件名 + \`.jsx\`。示例: \`"@/pages/admin/User.jsx"\`。
        *   如果 \`page\` 属性不以 \`/\` 开头 (例如 \`page="header.jsp"\`)，则 URL 为 \`"./"\` + 转换后的组件名 + \`.jsx\`。示例: \`"./Header.jsx"\`。
5.  **condition**: 如果JSP标签被包含在逻辑判断中，则提取该判断条件；否则，此字段为空字符串 \`""\`。
6.  **children**: 如果标签内有子标签，则递归地将它们转换为JSON对象并放入此数组；否则，数组为空 \`[]\`。
7.  **特殊处理 \`<jsp:param>\`**: 此标签自身不被转换为独立的JSON对象。它的 \`name\` 和 \`value\` 属性应该被提取出来，作为键值对直接添加到其父级标签的 \`attributes\` 对象中。

**输出要求:**
- 严格按照规则输出JSON。
- 不要输出任何介绍、解释、注释或markdown代码块标记。
- 只输出纯粹的、可以直接被JavaScript的 \`JSON.parse()\` 方法解析的JSON对象字符串。

---

**示例:**
输入 JSP: <jsp:include page="/components/common/header.jsp" id="header" />
输出 JSON: {"tagName":"Header","attributes":{"id":"header"},"isComponent":true,"componentUrl":"@/pages/components/common/Header.jsx","children":[]}

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    "c:if": {
        systemPrompt: `你是一个专门处理JSTL c:if 标签的专家。你的任务是将 c:if 标签及其内容转换为一个特定的JSON结构，用于表示条件渲染。`,
        userPromptTemplate: (content) => `
**任务:** 将 <c:if> 标签转换为JSON。

**规则:**
1.  **tagName**: 固定为 "ConditionalBlock"。
2.  **condition**: 提取 \`test\` 属性中的EL表达式作为字符串。
3.  **children**: 递归处理 \`<c:if>\` 内部的所有子节点。

---
**现在，请转换以下JSP代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    "html": {
        systemPrompt: `你是一位精通JSP、Struts 1，并且深刻理解如何将旧版代码迁移到现代React框架的专家级前端架构师。你的任务是将Struts的 'html' 标签库转换为一个“React友好”的JSON中间表示（IR）。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的 Struts 'html' 标签库代码片段，转换为一个旨在最终生成 React JSX 的、结构清晰的JSON对象。

**核心转换理念:**
你转换的目标不是1:1的字面翻译，而是要捕捉其“意图”，并将其映射到现代HTML5和React的最佳实践上。

**通用转换规则:**
1.  **tagName**: 将 Struts 标签转换为其最语义化的、现代小写 HTML5 标签名。
2.  **attributes**:
    *   迁移所有标准 HTML 属性（如 \`class\`, \`id\`, \`onclick\` 等）。
    *   **Style属性**: 将 \`style\` 字符串 (\`"width:100px; color:red"\`) 解析为 React 的内联样式对象 (\`{"width":"100px", "color":"red"}\`)。
    *   **Property属性 (关键)**: Struts 的 \`property\` 属性用于数据绑定。为了适配React的状态管理，它的值**必须**被映射到标准的 \`name\` 属性上。同时保留原始的 \`property\` 属性用于追溯。
3.  **isComponent**: 对于所有由 Struts 'html' 标签转换而来的元素，此值始终为 \`false\`。
4.  **children**: 递归处理所有子节点。
    * 如果子节点是普通标签，按规则继续转换。
    * 如果子节点是纯文本（例如 \`<html:link>Click</html:link>\` 里的 \`Click\`），必须转换为一个对象：
      \`\`\`json
      {"tagName":"#text","text":"Click","attributes":{},"children":[],"isComponent":false}
      \`\`\`

**特定标签映射规则 (React-aware):**
*   \`<html:form action="...">\` 转换为 \`{"tagName": "form", ...}\`。
*   \`<html:text property="user" />\` 转换为 \`{"tagName": "input", "attributes": {"type": "text", "property": "user", "name": "user"}}\`。
*   \`<html:password property="pass" />\` 转换为 \`{"tagName": "input", "attributes": {"type": "password", "property": "pass", "name": "pass"}}\`。
*   \`<html:textarea property="desc" />\` 转换为 \`{"tagName": "textarea", "attributes": {"property": "desc", "name": "desc"}}\`。
*   \`<html:submit value="Login" />\` 转换为 \`{"tagName": "button", "attributes": {"type": "submit"}, "text": "Login"}\` (使用 \`<button>\` 更灵活)。
*   \`<html:link href="/p">Go</html:link>\` 转换为 \`{"tagName": "a", "attributes": {"href": "/p"}, "text": "Go"}\`。
*   **\`<html:errors />\` (新规则): 这是一个占位符。将其转换为一个带有特定类名的空 \`<div>\`，并在内部添加注释文本。**

**输出要求:**
- 严格按照规则输出纯粹的、可被 \`JSON.parse()\` 解析的JSON对象字符串。
- 绝不输出任何解释、注释或Markdown代码块标记。

---

**示例 1: 包含数据绑定的输入框**
输入 JSP: <html:text property="username" style="width:200px;" maxlength="50" />
输出 JSON: {"tagName":"input","attributes":{"type":"text","property":"username","name":"username","style":{"width":"200px"},"maxlength":"50"},"children":[],"isComponent":false}

**示例 2: 表单和错误占位符**
输入 JSP: <html:form action="/login.do"><html:errors/><html:submit value="Login"/></html:form>
输出 JSON: {"tagName":"form","attributes":{"action":"/login.do"},"children":[{"tagName":"FormErrors","attributes":{},"children":[],"isComponent":false},{"tagName":"button","attributes":{"type":"submit"},"children":[],"isComponent":false,"text":"Login"}],"isComponent":false}

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    // --- 【新增】: 支持废弃的 <font> 标签 ---
    "font": {
        systemPrompt: `你是一位专注于将过时HTML代码现代化的前端重构专家。你的任务是将废弃的 <font> 标签精确地转换为使用内联CSS样式的JSON对象表示。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的 <font> 标签及其属性，转换为一个代表 <span> 元素的、使用CSS-in-JS风格样式的JSON对象。

**核心转换理念:**
<font> 标签已被废弃，其功能应由CSS完全取代。转换的目标是保留其视觉样式，同时升级到现代、标准的HTML结构。

**转换规则:**
1.  **tagName**: 始终将 <font> 标签转换为 "span"。这是一个中性的内联元素，非常适合应用样式。
2.  **attributes**:
    *   创建一个名为 "style" 的对象，用于存放所有样式属性。
    *   **color**: 将 \`color\` 属性的值直接映射到 \`style.color\`。
    *   **face**: 将 \`face\` 属性的值直接映射到 \`style.fontFamily\` (注意使用驼峰命名)。
    *   **size (关键)**: 将 \`size\` 属性 (值从1-7) 转换为对应的 \`fontSize\` 值。使用以下精确的像素映射规则：
        *   \`size="1"\`: \`"10px"\` (x-small)
        *   \`size="2"\`: \`"13px"\` (small)
        *   \`size="3"\`: \`"16px"\` (medium - 默认)
        *   \`size="4"\`: \`"18px"\` (large)
        *   \`size="5"\`: \`"24px"\` (x-large)
        *   \`size="6"\`: \`"32px"\` (xx-large)
        *   \`size="7"\`: \`"48px"\` (larger)
    *   如果其他属性（如 \`class\`, \`id\`）存在，也应保留在 \`attributes\` 中，与 \`style\` 对象同级。
3.  **isComponent**: 始终为 \`false\`。
4.  **children**: 递归处理所有子节点。
5.  **text**: 如果标签内部直接包含文本内容，则将该文本放入顶层的 \`text\` 字段。

**输出要求:**
- 严格按照规则输出纯粹的、可被 \`JSON.parse()\` 解析的JSON对象字符串。
- 绝不输出任何解释、注释或Markdown代码块标记。

---

**示例 1: 基本用法**
输入 JSP: <font color="blue" face="Arial" size="4">这是一个标题</font>
输出 JSON: {"tagName":"span","attributes":{"style":{"color":"blue","fontFamily":"Arial","fontSize":"18px"}},"children":[],"isComponent":false,"text":"这是一个标题"}

**示例 2: 只有颜色**
输入 JSP: <font color="#FF0000">错误信息</font>
输出 JSON: {"tagName":"span","attributes":{"style":{"color":"#FF0000"}},"children":[],"isComponent":false,"text":"错误信息"}

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    // --- 【新增】: 支持 Struts 'logic' 标签库 ---
    "logic": {
        systemPrompt: `你是一位精通 Struts 1 'logic' 标签库的专家，任务是将这些旧版的逻辑控制标签，转换为一个现代前端框架（如 React）能够理解的、结构化的 JSON 中间表示（IR）。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的 Struts 'logic' 标签库代码片段，转换为一个能清晰表达其“循环”或“条件”意图的JSON对象。

**核心转换理念:**
捕捉 Struts 'logic' 标签的本质功能——迭代和条件渲染，并用一个通用的、与具体实现无关的JSON结构来表示它。

**特定标签映射规则:**

1.  **\`<logic:iterate>\` (循环)**:
    *   **tagName**: 固定为字符串 \`"LoopBlock"\`。
    *   **collection**: 提取 \`name\` 或 \`property\` 属性的值，它代表要迭代的集合的名称。
    *   **item**: 提取 \`id\` 属性的值，它代表循环中每个元素的变量名。
    *   **children**: 递归处理 \`<logic:iterate>\` 标签内部的所有子节点，并将结果放入此数组。

2.  **条件标签 (如 \`<logic:equal>\`, \`<logic:notEqual>\`, \`<logic:present>\` 等)**:
    *   **tagName**: 固定为字符串 \`"ConditionalBlock"\`。
    *   **condition**: 将标签的意图和属性组合成一个易于理解的条件表达式字符串。
        *   \`<logic:equal name="user" property="role" value="admin">\` -> \`"user.role == 'admin'"\`
        *   \`<logic:notEqual name="status" value="0">\` -> \`"status != '0'"\`
        *   \`<logic:present name="user">\` -> \`"isPresent(user)"\`
        *   \`<logic:notPresent name="user">\` -> \`"!isPresent(user)"\`
        *   \`<logic:greaterThan name="count" value="10">\` -> \`"count > 10"\`
    *   **children**: 递归处理条件标签内部的所有子节点。

**输出要求:**
- 严格按照规则输出纯粹的、可被 \`JSON.parse()\` 解析的JSON对象字符串。
- 绝不输出任何解释、注释或Markdown代码块标记。

---

**示例 1: 循环标签**
输入 JSP:
\`\`\`jsp
<logic:iterate id="item" name="userList">
  <p>用户名: <bean:write name="item" property="name" /></p>
</logic:iterate>
\`\`\`
输出 JSON:
\`\`\`json
{"tagName":"LoopBlock","collection":"userList","item":"item","children":[{"tagName":"p","attributes":{},"children":[],"isComponent":false,"text":"用户名: <bean:write name=\\"item\\" property=\\"name\\" />"}]}
\`\`\`

**示例 2: 条件标签**
输入 JSP:
\`\`\`jsp
<logic:equal name="user" property="role" value="admin">
  <a href="/admin">管理后台</a>
</logic:equal>
\`\`\`
输出 JSON:
\`\`\`json
{"tagName":"ConditionalBlock","condition":"user.role == 'admin'","children":[{"tagName":"a","attributes":{"href":"/admin"},"children":[],"isComponent":false,"text":"管理后台"}]}
\`\`\`

**示例 3: 存在性判断**
输入 JSP:
\`\`\`jsp
<logic:present name="errorMessages">
  <div class="error">请修正错误</div>
</logic:present>
\`\`\`
输出 JSON:
\`\`\`json
{"tagName":"ConditionalBlock","condition":"isPresent(errorMessages)","children":[{"tagName":"div","attributes":{"class":"error"},"children":[],"isComponent":false,"text":"请修正错误"}]}
\`\`\`

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    // --- 【最终架构版】: 忽略ContextPath，移除.do后缀，区分组件/路由 ---
    "frameset": {
        systemPrompt: `你是一位顶尖的前端架构师，专注于将过时的JSP/Struts架构向现代React SPA迁移。你的任务是将废弃的 <frameset> 布局，精准地转换为一个能够生成干净、现代化路由的JSON中间表示（IR）。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的 <frameset> 及其内部的 <frame> 标签，转换为一个代表现代React布局与路由结构的、单一的JSON对象。

**核心转换理念:**
- **<frameset> -> 布局容器**: 转换为使用CSS Grid的 \`<div>\`。
- **<frame src="... .jsp"> -> 组件槽**: 代表直接渲染一个“视图组件”。
- **<frame src="... .do"> -> 路由槽**: 代表该区域是一个“路由出口”（Route Outlet）。
- **路径清理 (关键)**:
    1.  **忽略 Context Path**: 必须完全忽略和移除 \`<%=request.getContextPath()%> \` 表达式。
    2.  **移除 .do 后缀**: 来自 Struts 的 \`.do\` 路由必须被转换为干净、无后缀的现代路由路径。

**转换规则:**

1.  **顶层 \`<frameset>\` 标签:**
    *   **tagName**: \`"div"\`。
    *   **isComponent**: \`false\`。
    *   **attributes**:
        *   创建 \`"style"\` 对象并设置 \`"display": "grid"\`。
        *   根据 \`rows\`/\`cols\` 生成 \`gridTemplateRows\`/\`gridTemplateColumns\`。
        *   转换 \`on...\` 事件为驼峰格式。
    *   **children**: 包含所有 \`<frame>\` 转换后的JSON对象。

2.  **内部 \`<frame>\` 标签 (分类处理):**

    *   **预处理**: 在分析 \`src\` 属性前，必须先执行两个清理步骤：
        1.  移除所有的 \`<%=request.getContextPath()%>\` 部分。
        2.  如果路径以 \`.do\` 结尾，则移除 \`.do\` 后缀。
        *   例如: \`src="<%=request.getContextPath()%>/users/home.do"\` 应被视为纯粹的路径 \`"/users/home"\`。

    *   **Case A: 清理后的 \`src\` 指向视图模板 (e.g., \`.jsp\`)**
        *   视为 **“组件”**。
        *   **tagName**: 根据文件名生成驼峰组件名 (e.g., \`slogin.jsp\` -> \`Slogin\`)。
        *   **isComponent**: \`true\`。
        *   **componentUrl (重要路径规则)**: 根据清理后的 \`.jsp\` 路径生成对应的 \`.jsx\` 路径。如果路径以 \`/\` 开头，基地址为 \`"@/pages"\`；否则，基地址为 \`"./"\`。
        *   **attributes**: 包含除了 \`src\` 之外的所有其他原始属性 (例如 \`name\`, \`id\` 等)。\`src\` 属性已被用于逻辑判断和生成 \`componentUrl\`，因此不应出现在 \`attributes\` 中。

    *   **Case B: 清理后的 \`src\` 是一个路由路径 (原为 \`.do\`)**
        *   视为 **“路由”**。
        *   **tagName**: 固定为 \`"RouteOutlet"\`。
        *   **isComponent**: \`true\`。
        *   **attributes.defaultRoute**: 将清理后的、无后缀的路径作为字符串值赋给此属性。

    *   **Case C: 空 \`src\`**
        *   如果 \`src=""\`，转换为一个占位的 \`<div>\`。

**输出要求:**
- 严格按照规则输出单一、纯粹、可被 \`JSON.parse()\` 解析的JSON对象。
- 绝不输出任何解释、注释或Markdown代码块标记。

---

**示例:**
输入 JSP:
\`\`\`jsp
<frameset rows="80,*,0" onunload="javascript:logout()">
  <frame src="top.jsp" name="top">
  <frame src="<%=request.getContextPath()%>/users/home.do" name="main">
  <frame src="">
</frameset>
\`\`\`
输出 JSON (注意 top.jsp 转换后 attributes 中没有 page/src 属性):
\`\`\`json
{"tagName":"div","isComponent":false,"attributes":{"style":{"display":"grid","gridTemplateRows":"80px 1fr 0px"},"onUnload":"javascript.logout()"},"children":[{"tagName":"Top","isComponent":true,"componentUrl":"./Top.jsx","attributes":{"name":"top"},"children":[]},{"tagName":"RouteOutlet","isComponent":true,"attributes":{"defaultRoute":"/users/home","name":"main"},"children":[]},{"tagName":"div","isComponent":false,"attributes":{"data-comment":"Placeholder for empty frame"},"children":[]}]}
\`\`\`

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
    "object": {
        systemPrompt: `你是一位处理遗留HTML代码的专家。你的任务是将使用了ActiveX控件的 <object> 标签，转换为一个明确的JSON占位符组件，并保留其所有关键信息以便后续手动替换。`,
        userPromptTemplate: (content) => `
**任务:** 将给定的包含ActiveX控件的 <object> 标签转换为一个 "ActiveXPlaceholder" JSON组件。

**核心转换理念:**
ActiveX无法被现代浏览器支持，因此我们不能转换它，只能标记它并提取信息。目标是创建一个清晰的、信息完整的占位符，以便开发人员后续手动替换。

**转换规则:**
1.  **tagName**: 固定为字符串 \`"ActiveXPlaceholder"\`。这使得在代码库中搜索和处理这些待办项变得容易。
2.  **isComponent**: 始终为 \`true\`。
3.  **attributes**:
    *   将原始 \`<object>\` 标签的所有属性（如 \`id\`, \`classid\`, \`codebase\`, \`width\`, \`height\` 等）原封不动地复制到这个对象中。
    *   **关键**: 不要尝试解析或修改任何属性。
4.  **children**:
    *   查找所有 \`<param>\` 子标签。
    *   将每个 \`<param>\` 标签的 \`name\` 和 \`value\` 属性，提取为一个键值对。
    *   将所有这些键值对合并到一个名为 \`params\` 的单一对象中，并将其作为 \`children\` 数组的唯一元素。

**输出要求:**
- 严格按照规则输出纯粹的、可被 \`JSON.parse()\` 解析的JSON对象字符串。
- 绝不输出任何解释、注释或Markdown代码块标记。

---

**示例:**
输入 JSP:
\`\`\`jsp
<object id="scanner" classid="clsid:...." width="100%" height="500">
   <param name="scanUrl" value="/uploadScan.do">
   <param name="licenseKey" value="ABC-123">
</object>
\`\`\`
输出 JSON:
\`\`\`json
{
  "tagName": "ActiveXPlaceholder",
  "isComponent": true,
  "attributes": {
    "id": "scanner",
    "classid": "clsid:....",
    "width": "100%",
    "height": "500"
  },
  "children": [
    {
      "params": {
        "scanUrl": "/uploadScan.do",
        "licenseKey": "ABC-123"
      }
    }
  ]
}
\`\`\`

---

**现在，请根据以上所有规则，转换以下JSP代码:**

**输入 JSP 代码:**
\`\`\`jsp
${content}
\`\`\`
`
    },
};


/**
 * @description 从JSP代码片段中检测主要的标签类型
 * @param {string} code - JSP代码字符串
 * @returns {string|null} - 返回识别到的标签名或标签族 (例如 "jsp:include", "html", "font") 或 null
 */
// --- 【修改】: 更新检测逻辑以支持 <font> 等无前缀标签 ---
/**
 * 扫描片段，找到第一个属于 promptRegistry 的标签类型
 */
function detectMainTagType(code) {
    const trimmedCode = code.trim();

    // 匹配所有带前缀的标签 (如 <jsp:include>, <html:text>)
    const prefixTagMatches = [...trimmedCode.matchAll(/<([a-zA-Z0-9]+:[a-zA-Z0-9]+)/g)];
    for (const m of prefixTagMatches) {
        const fullTag = m[1].toLowerCase();
        if (promptRegistry.hasOwnProperty(fullTag)) {
            return fullTag;
        }
    }

    // 匹配所有无前缀的标签 (如 <font>, <table>)
    const standardTagMatches = [...trimmedCode.matchAll(/<([a-zA-Z0-9]+)/g)];
    for (const m of standardTagMatches) {
        const tagName = m[1].toLowerCase();
        if (promptRegistry.hasOwnProperty(tagName)) {
            return tagName;
        }
    }

    return null;
}

/**
 * 提取指定标签的完整片段（包括子节点）
 */
function extractTagContent(code, tagType) {
    // 区分是否有前缀（如 html:text / jsp:include）
    const [prefix, tagName] = tagType.includes(":") ? tagType.split(":") : [null, tagType];

    if (!prefix) {
        // 普通标签（如 font, table, div）
        const regex = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "i");
        const match = code.match(regex);
        return match ? match[0] : null;
    } else {
        // 前缀标签（如 jsp:include, html:text）
        const regex = new RegExp(`<${prefix}:${tagName}\\b[^>]*>([\\s\\S]*?<\\/${prefix}:${tagName}>)?`, "i");
        const match = code.match(regex);
        return match ? match[0] : null;
    }
}

// === 通用 Style 修复（由大模型完成） ===
const STYLE_FIX_SYSTEM_PROMPT = `
你是一名资深前端工程师与 CSS/React 样式专家。任务：把输入的内联 style 字符串修复为 React 可用的 inline-style 对象（仅输出 JSON 对象，不要包裹代码块）。
【必须遵守】
1) 只输出 JSON 对象（不能有多余文本/注释/Markdown）。
2) key 使用 React 驼峰：font-size->fontSize, background-color->backgroundColor。
3) 移除旧 IE/浏览器 hack：前缀 _、*，以及值中的 \\9、\\0、\\9\\0；忽略 \`!important\`（安全丢弃）。
4) 处理大小写与空格：属性名小写再转驼峰；值标准化（如 px 大写转小写）。
5) 单位补全（常见长度）：当值是纯数字且属性为长度类（width/height/top/left/right/bottom/margin*、padding*、borderWidth、borderRadius、fontSize、letterSpacing 等），补全 "px"。
   - 例外保持数字：opacity, zIndex, fontWeight, lineHeight（允许数字）。
6) 颜色：原样保留（可小写化），如 #FFF -> #fff；命名色保留为小写（red/blue）。
7) 简写展开（能判断则展开）：margin/padding/border-radius 等 1~4 值写法，展开为 top/right/bottom/left 四个属性；无法判断时可原样保留为一个字符串。
8) 过滤无效键：明显不是 CSS 的键直接忽略（但不要臆造新键）。
9) 不要返回 null/undefined，缺失则不含该键即可。
输出示例：
{"paddingLeft":"10px","color":"red","fontSize":"14px","width":"100px"}
`
function buildStyleFixUserPrompt(style, context) {
    return `
【输入的 style 字符串】
${style}

【上下文（可选）】
${context || "（无）"}

请严格输出一个 JSON 对象，键是 React 驼峰属性，值是字符串或数字。`;
}

// --- 【核心修改 1】: 重构工具函数，变为一个智能分发器 ---
export const availableTools = {
    /**
     * @description 接收任何JSP代码片段，内部判断其类型并调用相应的LLM处理流程。
     * @param {object} params - 参数对象
     * @param {string} params.content - 需要转换的JSP代码片段
     * @returns {Promise<string>} 转换后的JSON字符串，或一个包含错误的JSON字符串
     */
    convertJspSnippet: async ({ content }) => {
        if (!content) {
            return JSON.stringify({ error: "Missing content parameter." });
        }

        // 1. 在工具内部识别标签类型
        const detectedTagType = detectMainTagType(content);

        if (!detectedTagType) {
            return JSON.stringify({ error: "未识别出受支持的标签类型。" });
        }

        console.log(`检测到JSP标签类型: ${detectedTagType}`);


        // 提取该标签的完整内容
        const snippet = extractTagContent(content, detectedTagType) || content;
        // --- 【改造点】: jsp:include 走本地代码转换 ---
        if (detectedTagType === "jsp:include") {
            return convertJspInclude(content);
        }

        // 2. 从注册表中查找对应的提示词
        const prompts = promptRegistry[detectedTagType];
        if (!prompts) {
            // 3. 如果标签不受支持，立即返回错误
            return JSON.stringify({
                error: `Unsupported tag type: '${detectedTagType}'. This tool currently only supports: [${Object.keys(promptRegistry).join(', ')}]`
            });
        }

        // 4. 如果找到匹配的规则，则继续调用 OpenAI API
        const systemPrompt = prompts.systemPrompt;
        const userPrompt = prompts.userPromptTemplate(snippet);

        try {
            const response = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                messages: [
                    { "role": "system", "content": systemPrompt },
                    { "role": "user", "content": userPrompt }
                ],
                temperature: 0
            });

            let responseContent = response.choices[0].message.content;

            // 后处理逻辑保持不变
            if (responseContent.startsWith('```json')) {
                responseContent = responseContent.substring(7, responseContent.length - 3).trim();
            } else if (responseContent.startsWith('```')) {
                responseContent = responseContent.substring(3, responseContent.length - 3).trim();
            }

            return responseContent;

        } catch (error) {
            console.error("Error calling OpenAI API:", error);
            return JSON.stringify({ error: "Failed to process the request with OpenAI." });
        }
    },
    /**
   * 使用大模型将任意 style 字符串修复为 React 可用的 JSON 样式对象
   * @param {object} params
   * @param {string} params.style - 原始 style 字符串
   * @param {string} [params.context] - 可选上下文（元素标签/类名/用途等），辅助判断单位与展开
   * @returns {Promise<string>} 仅包含样式对象的 JSON 字符串
   */
    normalizeStyleWithLlm: async ({ style, context = "" }) => {
        if (!style || typeof style !== "string") {
            return JSON.stringify({});
        }

        try {
            const resp = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "qwen3-coder",
                temperature: 0,
                messages: [
                    { role: "system", content: STYLE_FIX_SYSTEM_PROMPT },
                    { role: "user", content: buildStyleFixUserPrompt(style, context) }
                ],
            });

            let out = resp.choices[0]?.message?.content?.trim() || "{}";
            // 兼容偶发代码块包裹
            if (out.startsWith("```")) {
                out = out.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
            }
            // 简单校验：必须是以 { 开头以 } 结尾
            if (!out.startsWith("{") || !out.endsWith("}")) {
                // 兜底：返回空对象，避免影响主流程
                return JSON.stringify({});
            }
            return out;
        } catch (e) {
            console.error("normalizeStyleWithLlm error:", e);
            return JSON.stringify({});
        }
    }
};

// --- 【核心修改 2】: 简化提供给 OpenAI 的工具定义 ---
export const tools = [
    {
        type: "function",
        function: {
            name: "convertJspSnippet", // 新的、更通用的函数名
            description: "将特定的JSP、Struts或废弃HTML标签片段转换为JSON。如果遇到以下标签，必须调用此工具：1. JSP/JSTL标签 (如 jsp:include, c:if)。2. Struts标签库 (如 html:text, logic:iterate)。3. 废弃或特殊处理的HTML标签 (如 font, frameset, 和用于ActiveX的 object)。",
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "包含需要转换的标签的完整代码片段。例如：'<object id=\"scanner\" classid=\"...\"><param name=\"url\" value=\"...\"></object>'"
                    }
                },
                required: ["content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "normalizeStyleWithLlm",
            description: "将不规范的 style 字符串清洗并转为 React 内联样式对象（JSON）。可处理旧 IE hack、大小写、缺失单位、连字符->驼峰，以及常见简写展开。",
            parameters: {
                type: "object",
                properties: {
                    style: { type: "string", description: "原始 style 字符串" },
                    context: { type: "string", description: "可选：元素信息（如 <td>、class 名、用途等），帮助判断单位与展开" }
                },
                required: ["style"]
            }
        }
    }
];