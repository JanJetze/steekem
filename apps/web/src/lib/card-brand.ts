/**
 * Detect card brand from the IIN (first 1-4 digits). Lightweight rule-based —
 * no Luhn validation, no full BIN database.
 *
 * Sources for the prefix ranges:
 *  - https://en.wikipedia.org/wiki/Payment_card_number
 *  - https://baymard.com/checkout-usability/credit-card-patterns
 */

export type CardBrand =
  | "Visa"
  | "Mastercard"
  | "Amex"
  | "Discover"
  | "JCB"
  | "Diners"
  | "UnionPay"
  | "Card";

export function detectBrand(num: string): CardBrand {
  const n = num.replace(/\D/g, "");
  if (!n) return "Card";
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[0-1]|720))/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^(6011|65|64[4-9])/.test(n)) return "Discover";
  if (/^35(2[89]|[3-8]\d)/.test(n)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(n)) return "Diners";
  if (/^62/.test(n)) return "UnionPay";
  return "Card";
}

/** Group digits with spaces in the conventional 4-4-4-4 layout (or 4-6-5
 *  for Amex). Non-digit characters are stripped before formatting. */
export function formatCardNumber(num: string, brand?: CardBrand): string {
  const n = num.replace(/\D/g, "");
  if (!n) return "";
  const b = brand ?? detectBrand(n);
  if (b === "Amex") {
    const parts = [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean);
    return parts.join(" ");
  }
  return n.match(/.{1,4}/g)?.join(" ") ?? n;
}

export function maxLength(brand: CardBrand): number {
  return brand === "Amex" ? 15 : brand === "Diners" ? 14 : 19; // UnionPay can be 19
}

export function cvcLength(brand: CardBrand): number {
  return brand === "Amex" ? 4 : 3;
}
