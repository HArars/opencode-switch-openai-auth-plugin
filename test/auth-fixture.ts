import type { OpenAIAuth } from "../src/types"

export function jwt(payload: unknown) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}
export function credential(refresh = "fake-refresh-1", user = "user-1", workspace = "workspace-1", expires = Date.now() + 60_000): OpenAIAuth {
  return {
    type: "oauth", refresh, expires, accountId: workspace,
    access: jwt({ iss: "https://auth.openai.com", email: `${user}@example.test`,
      "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: workspace, chatgpt_plan_type: "business" },
    }),
  }
}
