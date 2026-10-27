// Token estimate used for every size limit. Checked against a real tokenizer (npm run bench):
// ~3.5 characters per token is close for our compact output; ÷4 undercounted.
export const tokens = (s) => Math.ceil(s.length / 3.5);
