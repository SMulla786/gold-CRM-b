/** Mirrors Prisma enums so web + api share the same literals. */
export const USER_LEVELS = ['SUPER_ADMIN', 'ADMIN', 'BRANCH_USER'] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

export const STOCK_CLASSES = ['GOLD', 'SILVER', 'STONE', 'ARTIFICIAL', 'FRANCHISE'] as const;
export type StockClass = (typeof STOCK_CLASSES)[number];

/** Assets tracked in LedgerEntry (money + every stock class). */
export const LEDGER_ASSETS = ['MONEY', ...STOCK_CLASSES] as const;
export type LedgerAsset = (typeof LEDGER_ASSETS)[number];

/** Source of a ledger movement — the 25 sources in justudhari's Day-Book filter + our inter-branch STOCK_TRANSFER + OPENING_BALANCE + JUST_BILL. */
export const LEDGER_SOURCES = [
  'SELL_BILL',
  'PURCHASE_BILL',
  'ORDER_SELL_BILL',
  'ORDER_PURCHASE_BILL',
  'UDHAR',
  'IMPORT',
  'STOCK_INSERT',
  'BHAV_CUT',
  'SCHEME',
  'GIRVI',
  'INCOME_EXPENSE',
  'SELL_BILL_STOCK_RETURN',
  'PURCHASE_BILL_STOCK_RETURN',
  'ORDER_RECEIVE',
  'KARIGAR_ISSUE',
  'SET_STOCK',
  'EXCHANGE',
  'EXCHANGE_REFINE_PROCESS',
  'EXCHANGE_MELT_PROCESS',
  'EXCHANGE_REFINE',
  'BUY_SELL',
  'BUY_SELL_UDHAR',
  'BHAV_BOOKING',
  'BHAV_BOOKING_UDHAR',
  'REPAIR',
  'STOCK_TRANSFER',
  'OPENING_BALANCE',
  'JUST_BILL',
] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export const ACTIVITY_ACTIONS = ['CREATED', 'EDITED', 'DELETED', 'REVERSED'] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
