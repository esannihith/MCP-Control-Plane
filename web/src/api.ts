export interface Me {
  user: { email: string; name: string | null; avatarUrl: string | null; slug: string };
  csrf: string;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  if (!res.ok) return null;
  return (await res.json()) as Me;
}

export async function logout(csrf: string): Promise<void> {
  await fetch("/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } });
}
