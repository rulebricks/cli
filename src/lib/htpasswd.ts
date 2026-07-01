import bcrypt from "bcryptjs";

const BCRYPT_COST = 10;

export function generateHtpasswdLine(username: string, password: string): string {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) {
    throw new Error("Username is required");
  }
  if (normalizedUsername.includes(":")) {
    throw new Error("Username cannot contain ':'");
  }
  if (!password) {
    throw new Error("Password is required");
  }

  return `${normalizedUsername}:${bcrypt.hashSync(password, BCRYPT_COST)}`;
}
