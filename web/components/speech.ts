// Browser speech recognition (Chrome / Edge): a live preview while recording. The server (Gemini)
// produces the final transcript from the recording itself.
interface SpeechRecResult { isFinal: boolean; 0: { transcript: string } }
interface SpeechRecEvent { resultIndex: number; results: { length: number; [i: number]: SpeechRecResult } }
export interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
export function speechCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Couldn't read the recording"));
    r.readAsDataURL(b);
  });
}
