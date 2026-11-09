export const connectors = {
  'openai-images': {
    name: 'OpenAI Images',
    description: '通过项目统一的 render_image 工具生成和编辑图片。',
    tools: ['render_image'],
    configured: config => Boolean(config.apiKey),
  },
  'canvas-artifacts': {
    name: 'Canvas Artifacts',
    description: '保存图片版本与父子关系，并支持确定性换色和透明 Logo 合成。',
    tools: ['render_image', 'render_menu_layout', 'recolor_image', 'compose_logo_on_image'],
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
