import type { Request, Response, NextFunction } from "express";

/**
 * Baseline security headers. CSP allows self + inline styles (legacy dashboard
 * pages and the consent screen use inline <style>) and Google avatars.
 */
export function securityHeaders(secure: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://lh3.googleusercontent.com; frame-ancestors 'none'",
    );
    if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small fixed-window in-memory limiter for auth-ish endpoints. Per instance
 * (fine for a single-container deploy); keyed by client IP.
 */
export function rateLimit(options: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt < now) buckets.delete(key);
      }
    }
    const key = req.ip ?? "unknown";
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (++bucket.count > options.max) {
      res.status(429).json({ error: "rate_limited", retry_after_ms: bucket.resetAt - now });
      return;
    }
    next();
  };
}
