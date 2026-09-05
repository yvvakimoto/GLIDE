/** Type surface for ruby.mjs, so the vitest suite can hold it to account. */
export declare function readRuby(html: string): {
  text: string;
  display: Array<[start: number, len: number, text: string]>;
  gaiji: number;
};
