export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    // Hanya log jika ada akses tanpa sesi (bukan error normal user logout)
    if (req.session) {
      console.error(`[Auth] Unauthenticated request: ${req.method} ${req.path}`);
    }
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}