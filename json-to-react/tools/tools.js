import { openai } from "../../utils/common.js";

// 1. 定义工具 (工具的接口定义保持不变)
// 这个定义告诉模型：有一个名为 'filterAndGenerateReactComponent' 的工具，
// 它接收一个名为 'unfilteredJson' 的参数，这个参数是一个完整的 JSON 对象。
export const tools = [
    {
        type: "function",
        function: {
            name: "filterAndGenerateReactComponent",
            description: "接收一个包含完整HTML结构的JSON对象，移除其中html, head, body, meta, script等无关标签，然后从清理后的核心内容生成React组件代码。",
            parameters: {
                type: "object",
                properties: {
                    unfilteredJson: {
                        type: "object",
                        description: "包含完整DOM树结构的、未经处理的原始JSON对象。",
                    },
                },
                required: ["unfilteredJson"],
            },
        },
    },
];

/**
 * 实际执行过滤的函数 (新实现)。
 * 此函数现在调用大模型来清理JSON，而不是手动递归。
 * @param {object} inputJson 未经处理的原始JSON对象。
 * @returns {Promise<object>} 只包含核心UI元素的、经过清理的JSON对象。
 */
export async function filterAndGenerateReactComponent(inputJson) {
  console.log("正在使用大模型清理JSON...");

  const systemPrompt = `你是一个JSON转换机器人。你的任务是过滤一个代表DOM树的JSON对象。
  严格遵守以下规则：
  1. 移除 tagName 为 'meta', 'title', 'link', 'script', 'noscript' 的节点。
  2. 对于 tagName 为 'html', 'head', 'body' 的节点，不要包含节点本身，而是直接处理并包含其 children 数组中的内容。
  3. 递归处理所有子节点，确保深层嵌套的节点也符合规则。
  4. 最终输出必须是一个有效的、经过清理的JSON对象，不包含任何解释、注释或Markdown代码块。
  5. 输入的原始JSON结构为 { "elements": [...] }，你返回的清理后的JSON也必须保持 { "elements": [...] } 这种结构。`;

  try {
    const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4-turbo",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请根据规则清理以下JSON:\n${JSON.stringify(inputJson, null, 2)}` }
        ],
        temperature: 0,
        response_format: { type: "json_object" }, // 请求JSON格式输出以提高可靠性
    });

    const cleanedJsonString = response.choices[0].message.content;
    console.log("大模型返回的清理后JSON:", cleanedJsonString);
    
    // 解析大模型返回的JSON字符串
    const cleanedJson = JSON.parse(cleanedJsonString);
    return cleanedJson;

  } catch (error) {
    console.error("使用大模型清理JSON时出错:", error);
    // 在出错时抛出异常，以便上层调用者可以捕获
    throw new Error("大模型在清理JSON时失败。");
  }
}