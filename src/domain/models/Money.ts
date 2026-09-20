export class Money {
  // Amount represented internally in cents (1 USD = 100 cents)
  private readonly cents: number;

  private constructor(cents: number) {
    const rounded = Math.round(cents);
    if (!Number.isSafeInteger(rounded))
      throw new Error('Money must be a finite, safe integer number of cents');
    this.cents = rounded;
  }

  public static fromDollars(dollars: number): Money {
    if (typeof dollars !== 'number' || isNaN(dollars)) {
      throw new Error(`Invalid dollar amount: ${dollars}`);
    }
    return new Money(dollars * 100);
  }

  public static fromCents(cents: number): Money {
    if (typeof cents !== 'number' || isNaN(cents)) {
      throw new Error(`Invalid cents amount: ${cents}`);
    }
    return new Money(cents);
  }

  public static zero(): Money {
    return new Money(0);
  }

  public toDollars(): number {
    return Number((this.cents / 100).toFixed(2));
  }

  public toCents(): number {
    return this.cents;
  }

  public add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  public subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  public multiply(factor: number): Money {
    return new Money(this.cents * factor);
  }

  public percentage(pct: number): Money {
    return new Money((this.cents * pct) / 100);
  }

  // A spending ceiling must never round upwards beyond the allowed ratio.
  public floorPercentage(pct: number): Money {
    return new Money(Math.floor((this.cents * pct) / 100));
  }

  public isGreaterThan(other: Money): boolean {
    return this.cents > other.cents;
  }

  public isLessThan(other: Money): boolean {
    return this.cents < other.cents;
  }

  public isGreaterThanOrEqual(other: Money): boolean {
    return this.cents >= other.cents;
  }

  public isLessThanOrEqual(other: Money): boolean {
    return this.cents <= other.cents;
  }

  public equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  public toString(): string {
    return `$${this.toDollars().toFixed(2)}`;
  }

  public toJSON(): number {
    return this.toDollars();
  }
}
