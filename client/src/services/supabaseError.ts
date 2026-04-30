type SupabaseLikeError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export function getSupabaseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const supabaseError = error as SupabaseLikeError;
    return (
      supabaseError.message ||
      supabaseError.details ||
      supabaseError.hint ||
      "Supabase request failed."
    );
  }

  return "Supabase request failed.";
}

export function isRowLevelSecurityError(error: unknown): boolean {
  const message = getSupabaseErrorMessage(error).toLowerCase();
  return (
    message.includes("row-level security") ||
    message.includes("violates row-level security") ||
    message.includes("403") ||
    message.includes("forbidden")
  );
}
