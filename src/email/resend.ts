import type { Env } from "../types";

// Simple Resend integration. Free tier: 3000 emails/month.
// Get a key at https://resend.com/api-keys; default sender is `onboarding@resend.dev`.
// Once you add a verified domain, swap EMAIL_FROM to `noreply@yourdomain.com`.

export async function sendOtpEmail(env: Env, email: string, code: string): Promise<void> {
  const subject = "Your Whoopsie sign-in code";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111;">
      <h2 style="margin:0 0 12px;">Welcome back</h2>
      <p style="margin:0 0 24px;color:#666;">Use this code to sign in to Whoopsie:</p>
      <div style="font-size:36px;font-weight:700;letter-spacing:8px;font-family:monospace;
                  padding:16px;background:#f5f5f5;border-radius:8px;text-align:center;">
        ${code}
      </div>
      <p style="margin:24px 0 0;color:#999;font-size:13px;">
        Expires in ${env.OTP_TTL_MINUTES} minutes. If you didn't request this, ignore it.
      </p>
    </div>
  `;
  const text = `Your Whoopsie sign-in code: ${code}\nExpires in ${env.OTP_TTL_MINUTES} minutes.`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject,
      html,
      text,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`resend ${resp.status}: ${body}`);
  }
}
