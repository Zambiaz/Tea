// JWT issuing/verification helpers shared by auth routes and middleware.
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-in-production';
const TOKEN_TTL = '12h';

function signToken(user) {
    return jwt.sign({ sub: user.id, role: user.role, phone: user.phone_number, authVersion: Number(user.auth_version || 0) }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken };
