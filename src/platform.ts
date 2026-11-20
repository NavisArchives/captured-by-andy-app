/** The web app (studio.andyssarchives.com, `npm run build:web`) rather than the Mac app. */
export const WEB = import.meta.env.MODE === "web";

/** Set by the web app at start. */
export const webHooks = { signOut: null as null | (() => void), videoAvailable: null as null | ((id: string) => boolean) };

/** A touch screen without a mouse (a phone or tablet): taps open, the circle picks. */
export const touch = (): boolean => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
/** As narrow as a phone. */
export const phone = (): boolean => typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches;
