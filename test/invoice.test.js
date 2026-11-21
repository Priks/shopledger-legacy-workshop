const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const ledger = require('../lib/ledger');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function recordOrder(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1, orders: [] };
  const order = orders.add(db, { date: '2021-11-15', items, coupon, ...billed });
  return { db, order, billed };
}

test('invoice splits an odd GST cent the same way as checkout', () => {
  const { order, billed } = recordOrder([{ name: 'Tea', price: 10.05, qty: 1 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 11.86);
  assert.equal(order.tax, 1.81);
  assert.deepEqual([billed.cgst, billed.sgst], [0.91, 0.90]);
  assert.deepEqual(figures, {
    subtotal: 10.05,
    discount: 0,
    tax: 1.81,
    cgst: 0.91,
    sgst: 0.90,
    total: 11.86,
    rows: [{
      name: 'Tea', sku: '-', hsn: '-', qty: 1, price: 10.05,
      gstPercent: 18, line: 10.05, lineTax: 1.81
    }]
  });
  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹1\.81<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹11\.86<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice|Coupon Discount/);
});

test('a mixed-HSN SAVE10 invoice matches the billed total and per-item GST', () => {
  const { db, order, billed } = recordOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 200, qty: 2 },
    { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 200, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual(billed.lines, [
    { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 400, discount: 40, taxable: 360, tax: 18, net: 378 },
    { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 200, discount: 20, taxable: 180, tax: 21.60, net: 201.60 }
  ]);
  assert.equal(order.subtotal, 600);
  assert.equal(order.discount, 60);
  assert.equal(order.tax, 39.60);
  assert.equal(order.total, 579.60);
  assert.deepEqual([billed.cgst, billed.sgst], [19.80, 19.80]);

  // The order route charges the checkout total when the customer pays on khata.
  db.customers = [{ id: 1, name: 'Test customer' }];
  const charge = ledger.chargeOrderToKhata(db, 1, billed.total);
  assert.equal(charge.ok, true);
  assert.equal(charge.customer.totalBilled, 579.60);

  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 600,
    discount: 60,
    tax: 39.60,
    cgst: 19.80,
    sgst: 19.80,
    total: 579.60,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 200, gstPercent: 5, line: 400, lineTax: 18 },
      { name: 'Ghee', sku: 'GHEE', hsn: '0405', qty: 1, price: 200, gstPercent: 12, line: 200, lineTax: 21.60 }
    ]
  });

  const html = invoice.render(order);
  assert.match(html, /5%<\/td><td class="r">₹18\.00<\/td>/);
  assert.match(html, /12%<\/td><td class="r">₹21\.60<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹39\.60<\/td>/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹60\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹579\.60<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice applies an accepted flat coupon before GST', () => {
  const { order, billed } = recordOrder([{ name: 'Tea', price: 400, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(billed.taxable, 350);
  assert.equal(order.discount, 50);
  assert.equal(order.tax, 63);
  assert.equal(order.total, 413);
  assert.equal(figures.discount, 50);
  assert.equal(figures.rows[0].lineTax, 63);
  assert.equal(figures.tax, 63);
  assert.equal(figures.total, 413);
});

test('invoice preserves the capped SAVE10 discount and billed total', () => {
  const { order } = recordOrder([{ name: 'Tea', price: 2000, qty: 1 }], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 150);
  assert.equal(order.tax, 333);
  assert.equal(order.total, 2183);
  assert.equal(figures.discount, 150);
  assert.equal(figures.rows[0].lineTax, 333);
  assert.equal(figures.tax, 333);
  assert.equal(figures.total, 2183);
});

test('a stored flat coupon code does not override a recorded zero discount', () => {
  const items = [{ name: 'Tea', price: 40, qty: 1 }];
  const { order } = recordOrder(items);
  const figures = invoice.computeInvoiceFigures({ ...order, coupon: 'FLAT50' });

  assert.equal(pricing.computeTotals(items, 'FLAT50').discount, 0);
  assert.equal(order.total, 47.20);
  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 7.20);
  assert.equal(figures.total, 47.20);
});

test('invoice handles stored zero, decimal, and whole-percent GST rates like checkout', () => {
  const { order, billed } = recordOrder([
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Whole percent', price: 100, qty: 1, gstRate: 12 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[0, 0], [5, 5], [12, 12]]);
  assert.equal(order.tax, 17);
  assert.equal(order.total, 317);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[0, 0], [5, 5], [12, 12]]);
  assert.equal(figures.tax, 17);
  assert.deepEqual([figures.cgst, figures.sgst], [8.50, 8.50]);
  assert.equal(figures.total, 317);
});

test('invoice sums rounded line GST amounts like checkout', () => {
  const { order } = recordOrder([
    { name: 'First small line', price: 0.03, qty: 1 },
    { name: 'Second small line', price: 0.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.08);
  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.deepEqual([figures.cgst, figures.sgst], [0.01, 0.01]);
  assert.equal(figures.total, 0.08);
  assert.match(invoice.render(order), /Invoice Total<\/td><td class="r">₹0\.08<\/td>/);
});

test('invoice retains the billed discount and GST after a historical coupon expires', () => {
  const order = {
    id: 1,
    date: '2021-11-15',
    items: [{ name: 'Tea', price: 1000, qty: 1 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    discount: 200,
    tax: 144,
    total: 944
  };

  assert.equal(pricing.computeTotals(order.items, order.coupon).discount, 0);
  assert.equal(invoice.computeInvoiceFigures(order).rows[0].lineTax, 144);
  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1,
      date: '2021-11-15',
      customer: 'Walk-in',
      coupon: 'DIWALI20',
      ledgerSubtotal: 1000,
      ledgerDiscount: 200,
      ledgerTax: 144,
      ledgerTotal: 944,
      invoiceDiscount: 200,
      invoiceTax: 144,
      invoiceTotal: 944,
      delta: 0,
      matched: true
    }]
  });
  const html = invoice.render(order);
  assert.match(html, /Coupon Discount \(DIWALI20\)<\/td><td[^>]*>-₹200\.00<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹144\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹944\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice uses checkout rules for an order with missing recorded amounts', () => {
  const items = [{ name: 'Ghee', hsn: '0405', price: 400, qty: 1 }];
  const figures = invoice.computeInvoiceFigures({ items, coupon: 'FLAT50' });

  assert.equal(figures.subtotal, 400);
  assert.equal(figures.discount, 50);
  assert.equal(figures.rows[0].lineTax, 42);
  assert.equal(figures.tax, 42);
  assert.equal(figures.total, 392);
});
