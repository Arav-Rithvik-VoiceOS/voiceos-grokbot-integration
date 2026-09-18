/** Freeze confirmations with the same generator used for the full manifest.
 * This includes the package thread and its confirmation bridge for BOTH send
 * tools, plus a real roster/history snapshot. Never remove these declarations:
 * VoiceOS would fall back to its generic form before executing the handler.
 */
import "./gen-manifest.ts";
