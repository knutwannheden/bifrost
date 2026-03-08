/**
 * Convert Slack mrkdwn to plain text.
 *
 * Handles:
 * - Links: <URL|label> → label, <URL> → URL
 * - User mentions: <@U1234> → @user
 * - Channel mentions: <#C1234|name> → #name
 * - Mailto: <mailto:a@b.com|a@b.com> → a@b.com
 */
export function slackToPlainText(text: string): string {
  return (
    text
      // <URL|label> or <URL>
      .replace(/<([^>|]+)\|([^>]+)>/g, (_m, _url, label) => label)
      .replace(/<(https?:\/\/[^>]+)>/g, (_m, url) => url)
      // <mailto:email|label>
      .replace(/<mailto:[^|>]+\|([^>]+)>/g, (_m, label) => label)
      // <@U1234> user mentions
      .replace(/<@([A-Z0-9]+)>/g, (_m, id) => `@${id}`)
      // <#C1234|name> channel mentions
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_m, name) => `#${name}`)
      // HTML entities Slack sometimes includes
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  );
}
