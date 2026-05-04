export function getAuthErrorMessage(error: unknown): string {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  const lower = msg.toLowerCase();

  if (lower.includes("invalid login credentials") || lower.includes("invalid credentials"))
    return "Email or password is incorrect.";

  if (lower.includes("email not confirmed"))
    return "Please confirm your email before logging in. Check your inbox for a confirmation link.";

  if (lower.includes("user already registered") || lower.includes("already been registered"))
    return "An account with this email already exists. Please log in instead.";

  if (lower.includes("identity is already linked") || lower.includes("identity already"))
    return "This email is already connected to another sign-in method.";

  if (lower.includes("over_email_send_rate_limit") || lower.includes("email rate limit") || lower.includes("too many requests"))
    return "Too many requests. Please wait a moment and try again.";

  if (lower.includes("password should be at least") || lower.includes("password is too short"))
    return "Password must be at least 8 characters.";

  if (lower.includes("unable to validate email") || lower.includes("invalid email"))
    return "Please enter a valid email address.";

  if (lower.includes("network") || lower.includes("fetch") || lower.includes("failed to fetch"))
    return "Connection failed. Please check your internet connection.";

  if (lower.includes("access denied") || lower.includes("oauth") || lower.includes("provider"))
    return "We couldn't complete sign-in with Google. Please try again.";

  if (msg) return msg;
  return "Something went wrong. Please try again.";
}

export function isEmailExistsError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = msg.toLowerCase();
  return (
    lower.includes("user already registered") ||
    lower.includes("already been registered") ||
    lower.includes("email already")
  );
}
