/**
 * Permission catalog (source: docs/modules/12-rbac.md). Single source of truth for the DB seed,
 * API guards (`requirePermission('billing.sell_bill', 'edit')`) and the web permission matrix.
 * A module key gates plan access (Subscription.modules) and the "module toggle" in the matrix;
 * page keys carry view + optional edit/delete actions.
 */
export type PermissionAction = 'view' | 'edit' | 'delete';

export interface PageDef {
  key: string;
  label: string;
  /** false = page has no edit/delete toggles (view only). */
  actions: boolean;
}

export interface ModuleDef {
  key: string;
  label: string;
  /** Always enabled regardless of plan (e.g. dashboard, settings). */
  core?: boolean;
  pages: PageDef[];
}

const p = (key: string, label: string, actions = true): PageDef => ({ key, label, actions });

export const MODULES: ModuleDef[] = [
  { key: 'dashboard', label: 'Dashboard', core: true, pages: [p('dashboard.home', 'Dashboard', false)] },
  {
    key: 'billing',
    label: 'Billing',
    pages: [
      p('billing.sell_bill', 'Sell Bill'),
      p('billing.purchase_bill', 'Purchase Bill'),
      p('billing.just_bill', 'Just Bill'),
      p('billing.gst_report', 'GST Report'),
      p('billing.showroom_drafts', 'Showroom Drafts'),
      p('billing.draft_approvals', 'Draft Approvals'),
    ],
  },
  {
    key: 'orders',
    label: 'Orders Management',
    pages: [
      p('orders.list', 'Order Received List'),
      p('orders.create', 'Order Received'),
      p('orders.karigar_list', 'Karigar List'),
      p('orders.billing', 'Order Billing'),
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    pages: [
      p('inventory.dashboard', 'Inventory Dashboard'),
      p('inventory.item_masters', 'Item Groups/Names'),
      p('inventory.new_stock', 'New Stock'),
      p('inventory.import_stock', 'Import Stock'),
      p('inventory.all_stock', 'All Stock'),
      p('inventory.samples', 'Samples / Tounch'),
      p('inventory.scan_match', 'Scan/Match'),
      p('inventory.tag_print', 'Generate/Print'),
      p('inventory.printer_setting', 'Printer Setting'),
      p('inventory.tag_editor', 'Tag Editor'),
      p('inventory.stock_transfer', 'Stock Transfer'),
    ],
  },
  { key: 'udhari', label: 'Udhari', pages: [p('udhari.entry', 'Udhar'), p('udhari.ledger', 'Udhar Ledger')] },
  {
    key: 'girvi',
    label: 'Girvi',
    pages: [p('girvi.entry', 'Girvi New/Return'), p('girvi.ledger', 'Girvi Ledger'), p('girvi.transfer', 'Transfer List')],
  },
  {
    key: 'schemes',
    label: 'Schemes',
    pages: [
      p('schemes.text_messages', 'Text Messages'),
      p('schemes.customers', 'Customers'),
      p('schemes.enquiries', 'Enquiries'),
      p('schemes.all', 'All Scheme'),
      p('schemes.groups', 'Scheme Groups'),
      p('schemes.enroll', 'Advance Enroll Customer'),
      p('schemes.add_money', 'Add Money'),
      p('schemes.due_amount', 'Due Amount'),
      p('schemes.due_list', 'Due List'),
      p('schemes.transactions', 'Transactions'),
      p('schemes.daybook', 'Day Book'),
      p('schemes.anjuman', 'Anjuman'),
    ],
  },
  { key: 'repair', label: 'Jewellery Repair', pages: [p('repair.entry', 'Repair New/Old')] },
  {
    key: 'exchange',
    label: 'Old Jewellery Exchange',
    pages: [p('exchange.entry', 'Exchange New/Old'), p('exchange.list', 'Exchange List')],
  },
  {
    key: 'buy_sell',
    label: 'Buy Sell',
    pages: [p('buy_sell.entry', 'Buy Sell New'), p('buy_sell.list', 'Buy Sell List'), p('buy_sell.bhav_booking', 'Bhav Booking')],
  },
  {
    key: 'income_expense',
    label: 'Income / Expense',
    pages: [p('income_expense.entry', 'Add Income / Expense'), p('income_expense.list', 'Income / Expense List')],
  },
  {
    key: 'daybook',
    label: 'Day-Book',
    pages: [
      p('daybook.all_in_one', 'All IN ONE'),
      p('daybook.money', 'Money Txn'),
      p('daybook.gold', 'Gold Txn'),
      p('daybook.silver', 'Silver Txn'),
      p('daybook.artificial', 'Artificial Txn'),
      p('daybook.stone', 'Stone Txn'),
      p('daybook.franchise', 'Franchise Txn'),
    ],
  },
  { key: 'stock_summary', label: 'All Stock Summary', pages: [p('stock_summary.view', 'All Stock Summary', false)] },
  {
    key: 'settings',
    label: 'Settings',
    core: true,
    pages: [
      p('settings.parties', 'Customers / Suppliers / Karigars'),
      p('settings.misc', 'Settings Miscellaneous'),
      p('settings.integration', 'Integration'),
      p('settings.employees', 'Employees / Roles', false),
      p('settings.designations', 'Designations', false),
    ],
  },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);
export const PAGE_KEYS = MODULES.flatMap((m) => m.pages.map((pg) => pg.key));

/** Module key of a page key, e.g. 'billing.sell_bill' -> 'billing'. */
export const moduleOf = (pageKey: string): string => pageKey.split('.')[0]!;
