// The dashboard for Token Radar, model radar-2. It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, and a per-protocol
// detail view with the model's own inputs, a growth-sensitivity line and the protocol's farm
// plan. No network: every byte it shows is in data.js, and the page recomputes each row's
// implied value from the snapshot figures, so the code, the screenshots and board.json agree.
(function () {
  'use strict';

  var DATASET = window.RADAR;
  if (!DATASET) return;
  var mount = document.getElementById('board');
  var view = { q: '', category: 'all', chain: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function multLabel(n) { return (Math.round(n * 10000) / 10000).toFixed(2) + 'x'; }

  /** A growth figure clamped to the model's window, in per cent. */
  function clampGrowth(raw, model) {
    return Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
  }
  /** The maturity multiplier for a protocol of `age` days under `model`. */
  function maturityOf(age, model) {
    var days = age === null || age === undefined ? model.unknown_age_days : age;
    var bounded = Math.min(Math.max(days, 0), model.maturity_days);
    return model.maturity_floor + (bounded / model.maturity_days) * model.maturity_range;
  }

  // The radar-2 model in one function: the page recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page's code and the board's data are visibly the
  // same arithmetic. TVL sets the scale, growth orders inside it, age decides how much of it
  // counts, and a missing seven-day change is discounted 5%.
  function scoreRow(row, model) {
    var hasGrowth = row.change_7d !== null && row.change_7d !== undefined && isFinite(row.change_7d);
    var growth = clampGrowth(hasGrowth ? row.change_7d : 0, model);
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var maturity = maturityOf(row.age_days, model);
    var discount = hasGrowth ? 1 : model.missing_growth_discount;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * discount));
  }
  // The same row at 0% seven-day growth: what the rank would be without the week's momentum.
  function flatScore(row, model) {
    var maturity = maturityOf(row.age_days, model);
    var discount = row.change_7d !== null && row.change_7d !== undefined && isFinite(row.change_7d) ? 1 : model.missing_growth_discount;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * maturity * discount));
  }
  function rankAtFlat(flat) {
    var n = 0;
    for (var i = 0; i < DATASET.rows.length; i++) {
      if (DATASET.rows[i].implied_value_usd > flat) n++;
    }
    return n + 1;
  }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and
  // age decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasPriceFor(chain) {
    var key = String(chain).toLowerCase();
    if (key === 'ethereum') return { usd: 8, label: 'about $8 of gas on Ethereum' };
    if (key === 'solana') return { usd: 0.05, label: 'about $0.05 of gas on Solana' };
    if (key === 'binance') return { usd: 0.3, label: 'about $0.30 of gas on BNB Chain' };
    if (key === 'base' || key === 'arbitrum' || key === 'optimism' || key === 'polygon' || key === 'avalanche') return { usd: 1, label: 'about $1 of gas on ' + chain };
    return { usd: 3, label: 'about $3 of gas on ' + chain };
  }
  function capitalNeeded(p) {
    if (p.tvl_usd >= 1e10) return 300;
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdForAge(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function primaryAction(p, amount, chainName) {
    var kind = (p.category || '').toLowerCase();
    var protocolName = p.name;
    if (kind.indexOf('lend') >= 0 || kind.indexOf('cdp') >= 0 || kind.indexOf('collateral') >= 0) return `Supply $${amount} of USDC to ${protocolName} on ${chainName} and keep the position open.`;
    if (kind.indexOf('dex') >= 0 || kind.indexOf('yield') >= 0 || kind.indexOf('leveraged farm') >= 0) return `Provide $${amount} of liquidity to the main pool of ${protocolName} on ${chainName} and keep the position open.`;
    if (kind.indexOf('bridge') >= 0 || kind.indexOf('canonical bridge') >= 0) return `Bridge $${amount} of USDC to ${chainName} through ${protocolName} and use the bridged funds in its app.`;
    if (kind.indexOf('staking') >= 0 || kind.indexOf('restak') >= 0) return `Stake $${amount} of the chain staking asset through ${protocolName} and keep the receipt.`;
    if (kind.indexOf('perpetual') >= 0 || kind.indexOf('derivative') >= 0 || kind.indexOf('basis trading') >= 0) return `Deposit $${amount} of USDC as margin on ${protocolName} and open one small hedge.`;
    if (kind.indexOf('prediction') >= 0) return `Fund $${amount} and place one market position on ${protocolName}.`;
    if (kind.indexOf('curator') >= 0 || kind.indexOf('allocator') >= 0 || kind.indexOf('onchain capital') >= 0) return `Deposit $${amount} into a ${protocolName} vault on ${chainName} and keep the shares.`;
    if (kind.indexOf('stable') >= 0) return `Mint or deposit $${amount} of the stable asset through ${protocolName} on ${chainName}.`;
    if (kind.indexOf('rwa') >= 0) return `Mint $${amount} of the yield asset of ${protocolName} on ${chainName} and hold it.`;
    if (kind.indexOf('insurance') >= 0) return `Buy $${amount} of cover from ${protocolName} on ${chainName} and keep the policy.`;
    if (kind.indexOf('ai agent') >= 0) return `Deposit $${amount} into the agent vault of ${protocolName} on ${chainName} and keep the position open.`;
    return `Deposit $${amount} of USDC into ${protocolName} on ${chainName} and keep the position open.`;
  }
  function followUpAction(p, chainName) {
    var kind = (p.category || '').toLowerCase();
    var protocolName = p.name;
    if (kind.indexOf('lend') >= 0 || kind.indexOf('cdp') >= 0 || kind.indexOf('collateral') >= 0) return `Borrow $10 against the supply on ${protocolName} and repay it the same week.`;
    if (kind.indexOf('dex') >= 0 || kind.indexOf('yield') >= 0 || kind.indexOf('leveraged farm') >= 0) return `Swap $25 through the main pool of ${protocolName} on ${chainName} so the position is not a single deposit.`;
    if (kind.indexOf('bridge') >= 0 || kind.indexOf('canonical bridge') >= 0) return `Bridge $10 back the other way through ${protocolName} once to show two-way use.`;
    if (kind.indexOf('staking') >= 0 || kind.indexOf('restak') >= 0) return `Claim or restake the staking rewards from ${protocolName} once.`;
    if (kind.indexOf('perpetual') >= 0 || kind.indexOf('derivative') >= 0 || kind.indexOf('basis trading') >= 0) return `Close the hedge on ${protocolName} and open one fresh small position.`;
    if (kind.indexOf('prediction') >= 0) return `Close the first market position on ${protocolName} once it settles.`;
    if (kind.indexOf('curator') >= 0 || kind.indexOf('allocator') >= 0 || kind.indexOf('onchain capital') >= 0) return `Top up the ${protocolName} vault by $10 and keep the new shares.`;
    if (kind.indexOf('stable') >= 0) return `Redeem a small amount back to USDC through ${protocolName} and deposit it again.`;
    if (kind.indexOf('rwa') >= 0) return `Claim the yield distribution of ${protocolName} once.`;
    if (kind.indexOf('insurance') >= 0) return `Top up the cover from ${protocolName} by $10 and keep the policy.`;
    return `Make one swap or vote inside the app of ${protocolName} on ${chainName}.`;
  }
  function stepLine(step) {
    var s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function planSteps(p) {
    var chain = firstChain(p);
    var gas = gasPriceFor(chain);
    var capital = capitalNeeded(p);
    var hold = holdForAge(p.age_days);
    var weeklyGas = gas.usd < 1 ? '$' + gas.usd + ' of gas a week' : 'about $' + gas.usd + ' of gas a week';
    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes'
      },
      {
        text: primaryAction(p, capital, chain),
        cost: '$' + capital + ' of capital and ' + gas.label,
        time: '15 minutes to set up'
      },
      {
        text: followUpAction(p, chain),
        cost: 'about $' + (gas.usd < 1 ? gas.usd : Math.round(gas.usd)) + ' of gas plus the $10 to $25 moved',
        time: '10 minutes'
      },
      {
        text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
        cost: weeklyGas,
        time: '10 minutes a week'
      },
      {
        text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
        cost: 'the $' + capital + ' stays in the position',
        time: hold + ' days'
      },
      {
        text: 'Before you withdraw, open the points or rewards page of ' + p.name + ' and claim only from the link it publishes.',
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes'
      },
      {
        text: 'Write the wallet, the dates and every transaction in a farm log, then unwind in reverse order and keep gas aside for the exit transactions.',
        cost: 'exit gas, ' + gas.label,
        time: '10 minutes'
      }
    ].map(stepLine);
  }

  function readLocation() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('w') === '1') view.watchlistOnly = true;
  }
  function writeLocation() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchlistOnly) params.set('w', '1');
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATASET.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && (!r.chains || r.chains.indexOf(view.chain) < 0)) return false;
      if (view.watchlistOnly && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function orderedRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function medianValue() {
    var vals = DATASET.rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    if (!vals.length) return 0;
    return vals[Math.floor(vals.length / 2)];
  }
  function boardTotalTvl() {
    var sum = 0;
    for (var i = 0; i < DATASET.rows.length; i++) sum += DATASET.rows[i].tvl_usd;
    return sum;
  }

  function topBar() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('span', { class: 'brand-name', text: 'Token Radar' })),
      h('div', { class: 'top-meta' },
        h('span', { text: 'Snapshot ' + DATASET.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: DATASET.model_version + ' model' })
      )
    );
  }

  function intro() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: DATASET.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATASET.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATASET.early_size + ' pre-token protocols below that floor, found by TVL, not by name. Implied value is a model, not a promise: TVL sets the scale, seven-day growth orders inside it, and age with no token decides how much of it counts.' })
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATASET.watchlist_size + ' / ' + DATASET.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATASET.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATASET.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATASET.live_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Median implied value' }), h('b', { text: money(medianValue()) })),
        h('div', { class: 'fact' }, h('span', { text: 'Board TVL in total' }), h('b', { text: money(boardTotalTvl()) }))
      )
    );
  }

  function filters() {
    var categories = Array.from(new Set(DATASET.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATASET.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeLocation(); draw(); });
    var select = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeLocation(); draw(); });
    var chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return h('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; writeLocation(); draw(); });
    var watch = h('button', { type: 'button', 'aria-pressed': view.watchlistOnly ? 'true' : 'false', text: view.watchlistOnly ? 'Watchlist only: on' : 'Watchlist only', onclick: function () { view.watchlistOnly = !view.watchlistOnly; writeLocation(); draw(); } });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; draw(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; draw(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), select),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Scope' }), watch),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATASET.live.length + ' live-token protocols' })
    );
  }

  function sortButton(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } draw(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardView() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchlistOnly = false; writeLocation(); draw(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var rankClass = r.rank <= 3 ? 'top3' : '';
      var tr = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { showDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r.slug); } }
      },
        h('td', { class: 'num rank ' + rankClass, text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.watchlist ? ' - watchlist' : '') })
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortButton('implied', 'Rank'),
            sortButton('name', 'Protocol'),
            sortButton('tvl', 'TVL'),
            sortButton('growth', '7d'),
            sortButton('age', 'Age'),
            sortButton('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveView() {
    var tbody = h('tbody');
    DATASET.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelNote() {
    var m = DATASET.model;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        'implied = round( tvl_usd x ' + m.base_multiple + ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x discount )'
      ),
      h('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days, and a missing seven-day change counts as 0% with a ' + m.missing_growth_discount + ' discount. Growth weighs ' + m.growth_weight + ' because a compounding protocol is worth more per dollar locked than one bleeding TVL, and the clamp keeps one data spike from buying the board. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  var detailDialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  detailDialog.addEventListener('close', function () { view.selected = null; writeLocation(); });

  function showDetail(slug) {
    var row = DATASET.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeLocation();
    detailDialog.textContent = '';
    var steps = planSteps(row);
    var flat = flatScore(row, DATASET.model);
    var flatAt = rankAtFlat(flat);
    var diff = row.implied_value_usd - flat;
    var sensitivity = diff > 0
      ? 'This week growth adds ' + money(diff) + ' to the implied value: at 0% growth it would be ' + money(flat) + ', about rank ' + flatAt + '.'
      : diff < 0
        ? 'This week decline costs ' + money(-diff) + ' of implied value: at 0% growth it would be ' + money(flat) + ', about rank ' + flatAt + '.'
        : 'At 0% growth the implied value would be the same ' + money(flat) + ', about rank ' + flatAt + '.';
    var capital = capitalNeeded(row);
    var gas = gasPriceFor(firstChain(row));
    var hold = holdForAge(row.age_days);
    detailDialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATASET.board_size + (row.watchlist ? ' - watchlist' : ' - early radar') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { detailDialog.close(); } })
    ));
    detailDialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: multLabel(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: multLabel(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Data discount' }), h('b', { class: 'num', text: multLabel(row.data_discount) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: 'Model ' + DATASET.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(scoreRow(row, DATASET.model)) + (scoreRow(row, DATASET.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' ' + sensitivity + ' This is an estimate, not a price.' })
    ));
    detailDialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('p', { class: 'sub', text: 'Farm total: $' + capital + ' of capital plus ' + gas.label + ' to start, hold at least ' + hold + ' days.' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof detailDialog.showModal === 'function') {
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      detailDialog.setAttribute('open', '');
    }
  }

  function draw() {
    mount.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filters());
    shell.appendChild(view.tab === 'pre-token' ? boardView() : liveView());
    if (view.tab === 'pre-token') shell.appendChild(modelNote());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!detailDialog.isConnected) mount.appendChild(detailDialog);
    if (view.selected) showDetail(view.selected);
  }

  readLocation();
  draw();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detailDialog.open) detailDialog.close();
  });
})();
