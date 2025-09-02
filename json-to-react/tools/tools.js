// import { openai } from "../../utils/common.js";

// 1. 定义工具 (工具的接口定义保持不变)
// 这个定义告诉模型：有一个名为 'filterAndGenerateReactComponent' 的工具，
// 它接收一个名为 'unfilteredJson' 的参数，这个参数是一个完整的 JSON 对象。
export const tools = [
    // {
    //     type: "function",
    //     function: {
    //         name: "filterAndGenerateReactComponent",
    //         description: "接收一个包含完整HTML结构的JSON对象，移除其中html, head, body, meta, script等无关标签，然后从清理后的核心内容生成React组件代码。",
    //         parameters: {
    //             type: "object",
    //             properties: {
    //                 unfilteredJson: {
    //                     type: "object",
    //                     description: "包含完整DOM树结构的、未经处理的原始JSON对象。",
    //                 },
    //             },
    //             required: ["unfilteredJson"],
    //         },
    //     },
    // },
        // <<< 新增：定义RouteOutlet导航工具 >>>
    {
        type: "function",
        function: {
            name: "handleRouteOutlet",
            description: "处理 tagName 为 RouteOutlet 的节点，用于页面跳转。需要从节点的 attributes 中提取 'to' 属性作为跳转路径。",
            parameters: {
                type: "object",
                properties: {
                    to: {
                        type: "string",
                        description: "目标跳转路径, 例如 '/home' 或 '/user/profile'。",
                    },
                },
                required: ["to"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "handleActiveXPlaceholder",
            description: "处理 tagName 为 'ActiveXPlaceholder' 的特殊节点。此节点代表一个需要手动替换的、过时的ActiveX控件。此工具将提取其所有元数据（attributes 和 params）用于生成一个明确的占位符组件。",
            parameters: {
                type: "object",
                properties: {
                    attributes: {
                        type: "object",
                        description: "原始 <object> 标签的所有属性，例如 'id', 'classid', 'width', 'height'。",
                    },
                    // 注意：根据之前的设计，params被包裹在children数组中，LLM需要学会提取它
                    // 为了简化，我们可以让LLM直接传递params对象
                    params: {
                        type: "object",
                        description: "从原始 <param> 子标签中提取的所有键值对。",
                    },
                },
                required: ["attributes", "params"],
            },
        },
    }
];

// /**
//  * 实际执行过滤的函数 (新实现)。
//  * 此函数现在调用大模型来清理JSON，而不是手动递归。
//  * @param {object} inputJson 未经处理的原始JSON对象。
//  * @returns {Promise<object>} 只包含核心UI元素的、经过清理的JSON对象。
//  */
// export async function filterAndGenerateReactComponent(inputJson) {
//   console.log("正在使用大模型清理JSON...");

//   const systemPrompt = `你是一个JSON转换机器人。你的任务是过滤一个代表DOM树的JSON对象。
//   严格遵守以下规则：
//   1. 移除 tagName 为 'meta', 'title', 'link', 'script', 'noscript' 的节点。
//   2. 对于 tagName 为 'html', 'head', 'body' 的节点，不要包含节点本身，而是直接处理并包含其 children 数组中的内容。
//   3. 递归处理所有子节点，确保深层嵌套的节点也符合规则。
//   4. 最终输出必须是一个有效的、经过清理的JSON对象，不包含任何解释、注释或Markdown代码块。
//   5. 输入的原始JSON结构为 { "elements": [...] }，你返回的清理后的JSON也必须保持 { "elements": [...] } 这种结构。`;

//   try {
//     const response = await openai.chat.completions.create({
//         model: process.env.OPENAI_MODEL || "gpt-4-turbo",
//         messages: [
//             { role: "system", content: systemPrompt },
//             { role: "user", content: `请根据规则清理以下JSON:\n${JSON.stringify(inputJson, null, 2)}` }
//         ],
//         temperature: 0,
//         response_format: { type: "json_object" }, // 请求JSON格式输出以提高可靠性
//     });

//     const cleanedJsonString = response.choices[0].message.content;
    
//     // 解析大模型返回的JSON字符串
//     const cleanedJson = JSON.parse(cleanedJsonString);
//     return cleanedJson;

//   } catch (error) {
//     console.error("使用大模型清理JSON时出错:", error);
//     // 在出错时抛出异常，以便上层调用者可以捕获
//     throw new Error("大模型在清理JSON时失败。");
//   }
// }

/**
 * <<< 新增：实现RouteOutlet工具函数 >>>
 * 实际处理导航的函数。
 * @param {object} args 包含跳转路径 'to' 的对象。
 * @returns {Promise<object>} 一个包含导航指令和路径的对象。
 */
export async function handleRouteOutlet({ to }) {
    console.log(`识别到导航请求，目标路径: '${to}'`);
    if (!to || typeof to !== 'string') {
        throw new Error("导航路径 'to' 不能为空且必须是字符串。");
    }
    // 返回一个结构化的对象，主LLM将根据这个对象的意图来生成最终代码
    return {
        type: "navigation-instruction",
        path: to,
        message: `请生成一个使用react-router-dom的useNavigate钩子跳转到'${to}'的代码。`
    };
}

/**
 * <<< 新增：实现 ActiveXPlaceholder 工具函数 >>>
 * 处理遗留 ActiveX 控件的元数据。
 * @param {object} args - 包含原始属性和参数的对象。
 * @param {object} args.attributes - <object> 标签的属性。
 * @param {object} args.params - <param> 标签提取出的键值对。
 * @returns {Promise<object>} 一个给主LLM的指令对象。
 */
export async function handleActiveXPlaceholder({ attributes, params }) {
    console.log(`识别到ActiveX占位符，元数据:`, { attributes, params });

    // 根据原始id生成一个更有意义的组件名
    const componentName = attributes?.id 
        ? `${attributes.id.charAt(0).toUpperCase() + attributes.id.slice(1)}Placeholder` 
        : "LegacyActiveXPlaceholder";

    // 返回一个结构化指令。主LLM将使用它来生成最终代码。
    return {
        type: "placeholder-component-instruction",
        componentName: componentName,
        props: {
            attributes,
            params
        },
        message: `请生成一个名为 ${componentName} 的React组件。这个组件是一个占位符，需要明确警告开发者这是一个需要手动替换的遗留功能。请在组件内部展示所有的 props 信息。`
    };
}