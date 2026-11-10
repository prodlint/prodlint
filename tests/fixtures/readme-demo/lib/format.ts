import { formatCurrency } from "currency-format-utils";

export function price(cents: number) {
  return formatCurrency(cents / 100, "USD");
}
