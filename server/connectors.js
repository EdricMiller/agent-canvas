export const connectors = {
  'openai-images': {
    name: 'OpenAI Images',
    description: '通过项目统一的 render_image 工具生成和编辑图片。',
    tools: ['render_image'],
    configured: config => Boolean(config.apiKey),
  },
  'canvas-artifacts': {
    name: 'Canvas Artifacts',
    description: '保存图片版本与父子关系。',
    tools: ['render_image', 'render_menu_layout'],
    configured: () => true,
  },
};

export function listConnectors(config) {
  return Object.entries(connectors).map(([id, connector]) => ({
    id,
    name: connector.name,
    description: connector.description,
    tools: connector.tools,
    configured: connector.configured(config),
  }));
}
