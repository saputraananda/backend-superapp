export function requireAuth(req, res, next) {
  console.log("requireAuth - Full session:", req.session);
  console.log("requireAuth - userId:", req.session.userId);
  console.log("requireAuth - employeeId:", req.session.employeeId);
  
  // Check if user is authenticated
  if (!req.session.userId) {
    return res.status(401).json({ 
      message: "Not authenticated",
      debug: {
        hasSession: !!req.session,
        hasUserId: !!req.session.userId,
        hasEmployeeId: !!req.session.employeeId
      }
    });
  }
  next();
}