export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramHtml(text: string): string {
  let html = escapeHtml(text);

  html = html.replace(/```([\s\S]*?)```/g, (_match, code: string) => `<pre>${code.trim()}</pre>`);
  html = html.replace(/`([^`\n]+?)`/g, (_match, code: string) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, (_match, value: string) => `<b>${value}</b>`);

  return html;
}
