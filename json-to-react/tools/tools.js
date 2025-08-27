// 1. 定义工具
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
 * 实际执行过滤的函数。
 * 当模型请求调用工具时，您的服务器将运行此代码。
 * @param {object} inputJson 未经处理的原始JSON。
 * @returns {object} 只包含核心UI元素的、经过清理的JSON。
 */
export function filterAndGenerateReactComponent(inputJson) {
  const tagsToRemove = ['meta', 'title', 'link', 'script', 'noscript'];
  const tagsToFlatten = ['html', 'head', 'body'];

  function recursiveFilter(nodes) {
    if (!Array.isArray(nodes)) {
      return [];
    }
    return nodes.flatMap(node => {
      if (tagsToRemove.includes(node.tagName)) {
        return [];
      }
      if (tagsToFlatten.includes(node.tagName)) {
        return recursiveFilter(node.children);
      }
      return [{
        ...node,
        children: recursiveFilter(node.children)
      }];
    });
  }

  const newJson = JSON.parse(inputJson);
  newJson.elements = recursiveFilter(newJson.elements);
  return newJson;
}