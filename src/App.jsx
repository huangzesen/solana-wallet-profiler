import { useState, useCallback } from 'react'
import './App.css'

const RPC = 'https://api.mainnet-beta.solana.com'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'

const SAMPLE_WALLETS = [
  { label: 'Bonk Treasury', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { label: 'Jupiter DAO', address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' },
  { label: 'Solana Foundation', address: '3R3h7oZ9F7C6jX6NZJ6mHjz4v6J7X7Z7z7Z7z7Z7z7Z' },
]

async function rpcCall(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}

async function fetchSolPrice() {
  try {
    const r = await fetch(SOL_PRICE_API)
    const d = await r.json()
    return d.solana?.usd ?? 0
  } catch { return 0 }
}

async function fetchTokenAccounts(wallet) {
  const res = await rpcCall('getTokenAccountsByOwner', [
    wallet,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' },
  ])
  return (res?.value || []).map(v => {
    const info = v.account.data.parsed.info
    return {
      mint: info.mint,
      amount: parseFloat(info.tokenAmount.uiAmountString || '0'),
      decimals: info.tokenAmount.decimals,
      pubkey: v.pubkey,
    }
  }).filter(t => t.amount > 0)
}

async function fetchRecentTxs(wallet, limit = 50) {
  const sigs = await rpcCall('getSignaturesForAddress', [wallet, { limit }])
  if (!sigs?.length) return []
  
  const txs = []
  // Fetch in batches of 10
  for (let i = 0; i < sigs.length; i += 10) {
    const batch = sigs.slice(i, i + 10)
    const results = await Promise.all(
      batch.map(async sig => {
        try {
          const tx = await rpcCall('getTransaction', [
            sig.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ])
          return tx ? { ...tx, signature: sig.signature, blockTime: sig.blockTime } : null
        } catch { return null }
      })
    )
    txs.push(...results.filter(Boolean))
  }
  return txs
}

function analyzeTransactions(txs, wallet) {
  const now = Math.floor(Date.now() / 1000)
  const day = 86400
  const stats = {
    totalTxs: txs.length,
    firstTx: null,
    lastTx: null,
    txsPerDay: 0,
    uniquePrograms: new Set(),
    tokenSwaps: 0,
    solTransfers: 0,
    nftActivity: 0,
    defiProtocols: new Set(),
    activityByMonth: {},
    topInteractions: {},
  }

  const knownDeFi = {
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'Openbook',
    'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ': 'Saber',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'Pump.fun AMM',
  }

  const knownNFT = {
    'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTT5mo5B7CLFG': 'Magic Eden v2',
    'TSWAPaqyCSx2KABk68Shr1DP9r8BMcLna6HNaGW3kod': 'Tensor',
  }

  for (const tx of txs) {
    if (!tx.blockTime) continue
    
    const ts = tx.blockTime
    if (!stats.firstTx || ts < stats.firstTx) stats.firstTx = ts
    if (!stats.lastTx || ts > stats.lastTx) stats.lastTx = ts

    const month = new Date(ts * 1000).toISOString().slice(0, 7)
    stats.activityByMonth[month] = (stats.activityByMonth[month] || 0) + 1

    const msg = tx.transaction?.message
    if (!msg) continue

    const instructions = msg.instructions || []
    const inner = tx.meta?.innerInstructions || []
    const allIxs = [...instructions, ...inner.flatMap(i => i.instructions || [])]

    for (const ix of allIxs) {
      const pid = ix.programId
      if (!pid) continue
      stats.uniquePrograms.add(pid)

      if (knownDeFi[pid]) {
        stats.defiProtocols.add(knownDeFi[pid])
        stats.tokenSwaps++
      }
      if (knownNFT[pid]) {
        stats.nftActivity++
      }
      
      stats.topInteractions[pid] = (stats.topInteractions[pid] || 0) + 1
    }

    // Check for SOL transfers
    const preBal = tx.meta?.preBalances || []
    const postBal = tx.meta?.postBalances || []
    const walletIdx = msg.accountKeys?.findIndex(k => 
      (typeof k === 'string' ? k : k.pubkey) === wallet
    )
    if (walletIdx >= 0) {
      const diff = (postBal[walletIdx] || 0) - (preBal[walletIdx] || 0)
      if (Math.abs(diff) > 0.01 * 1e9 && !stats.defiProtocols.size) {
        stats.solTransfers++
      }
    }
  }

  const timeSpan = stats.lastTx && stats.firstTx ? stats.lastTx - stats.firstTx : 0
  stats.txsPerDay = timeSpan > 0 ? (stats.totalTxs / (timeSpan / day)).toFixed(1) : stats.totalTxs
  stats.uniquePrograms = stats.uniquePrograms.size
  stats.defiProtocols = [...stats.defiProtocols]
  stats.walletAge = timeSpan > 0 ? Math.floor(timeSpan / day) : 0

  // Top interactions
  const sortedInteractions = Object.entries(stats.topInteractions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  stats.topInteractions = sortedInteractions

  return stats
}

function formatSOL(lamports) {
  return (lamports / 1e9).toFixed(4)
}

function shorten(addr) {
  if (!addr) return ''
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default function App() {
  const [wallet, setWallet] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [progress, setProgress] = useState('')

  const analyze = useCallback(async (addr) => {
    if (!addr || addr.length < 32) return
    setLoading(true)
    setError('')
    setData(null)
    
    try {
      setProgress('Fetching SOL balance...')
      const balance = await rpcCall('getBalance', [addr])
      
      setProgress('Fetching token accounts...')
      const tokens = await fetchTokenAccounts(addr)
      
      setProgress('Fetching SOL price...')
      const solPrice = await fetchSolPrice()
      
      setProgress('Fetching transaction history...')
      const txs = await fetchRecentTxs(addr, 100)
      
      setProgress('Analyzing wallet activity...')
      const stats = analyzeTransactions(txs, addr)
      
      const solBalance = balance?.value / 1e9 || 0
      const portfolioValue = solBalance * solPrice

      setData({
        address: addr,
        solBalance,
        solPrice,
        portfolioValue,
        tokens: tokens.sort((a, b) => b.amount - a.amount).slice(0, 20),
        tokenCount: tokens.length,
        stats,
        recentTxs: txs.slice(0, 10).map(tx => ({
          signature: tx.signature,
          time: tx.blockTime,
          success: tx.meta?.err === null,
          fee: tx.meta?.fee || 0,
        })),
      })
      setProgress('')
    } catch (e) {
      setError(e.message || 'Failed to analyze wallet')
      setProgress('')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    analyze(wallet.trim())
  }

  const statCard = (label, value, sub) => (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )

  return (
    <div className="app">
      <header>
        <h1>🔍 Solana Wallet Profiler</h1>
        <p className="subtitle">Deep analytics for any Solana wallet — activity patterns, DeFi usage, portfolio & more</p>
      </header>

      <form onSubmit={handleSubmit} className="search-form">
        <input
          type="text"
          value={wallet}
          onChange={e => setWallet(e.target.value)}
          placeholder="Enter Solana wallet address..."
          className="wallet-input"
        />
        <button type="submit" disabled={loading || !wallet.trim()}>
          {loading ? 'Analyzing...' : 'Analyze Wallet'}
        </button>
      </form>

      <div className="sample-wallets">
        <span>Try: </span>
        {SAMPLE_WALLETS.map(w => (
          <button key={w.address} className="sample-btn" onClick={() => { setWallet(w.address); analyze(w.address) }}>
            {w.label}
          </button>
        ))}
      </div>

      {progress && <div className="progress">{progress}</div>}
      {error && <div className="error">{error}</div>}

      {data && (
        <div className="results">
          <div className="wallet-header">
            <h2>Wallet Analysis</h2>
            <code className="address">{data.address}</code>
          </div>

          {/* Portfolio Overview */}
          <section className="section">
            <h3>💰 Portfolio</h3>
            <div className="stats-grid">
              {statCard('SOL Balance', `${data.solBalance.toFixed(4)} SOL`, `≈ $${(data.solBalance * data.solPrice).toFixed(2)}`)}
              {statCard('SOL Price', `$${data.solPrice.toFixed(2)}`)}
              {statCard('Token Holdings', data.tokenCount, 'SPL tokens')}
              {statCard('Portfolio Value', `≈ $${data.portfolioValue.toFixed(2)}`, 'SOL only')}
            </div>
          </section>

          {/* Wallet Activity */}
          <section className="section">
            <h3>📊 Activity Profile</h3>
            <div className="stats-grid">
              {statCard('Total Transactions', data.stats.totalTxs, 'recent batch')}
              {statCard('Wallet Age', `${data.stats.walletAge} days`)}
              {statCard('Tx Frequency', `${data.stats.txsPerDay} tx/day`)}
              {statCard('Programs Used', data.stats.uniquePrograms, 'unique')}
            </div>
          </section>

          {/* DeFi & Trading */}
          <section className="section">
            <h3>🔄 DeFi & Trading</h3>
            <div className="stats-grid">
              {statCard('Token Swaps', data.stats.tokenSwaps)}
              {statCard('DeFi Protocols', data.stats.defiProtocols.length, data.stats.defiProtocols.join(', ') || 'none detected')}
              {statCard('NFT Activity', data.stats.nftActivity, 'transactions')}
              {statCard('SOL Transfers', data.stats.solTransfers)}
            </div>
          </section>

          {/* Activity Timeline */}
          {Object.keys(data.stats.activityByMonth).length > 0 && (
            <section className="section">
              <h3>📅 Activity by Month</h3>
              <div className="timeline">
                {Object.entries(data.stats.activityByMonth)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([month, count]) => (
                    <div key={month} className="timeline-bar">
                      <span className="timeline-label">{month}</span>
                      <div className="timeline-fill" style={{ width: `${Math.min(100, (count / Math.max(...Object.values(data.stats.activityByMonth))) * 100)}%` }} />
                      <span className="timeline-count">{count}</span>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* Top Tokens */}
          {data.tokens.length > 0 && (
            <section className="section">
              <h3>🪙 Top Token Holdings</h3>
              <table className="token-table">
                <thead>
                  <tr><th>#</th><th>Token Mint</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {data.tokens.slice(0, 10).map((t, i) => (
                    <tr key={t.pubkey}>
                      <td>{i + 1}</td>
                      <td><code>{shorten(t.mint)}</code></td>
                      <td>{t.amount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Recent Transactions */}
          {data.recentTxs.length > 0 && (
            <section className="section">
              <h3>🔗 Recent Transactions</h3>
              <div className="tx-list">
                {data.recentTxs.map(tx => (
                  <div key={tx.signature} className={`tx-item ${tx.success ? 'success' : 'failed'}`}>
                    <span className="tx-sig">
                      <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" rel="noopener">
                        {shorten(tx.signature)}
                      </a>
                    </span>
                    <span className="tx-time">{tx.time ? timeAgo(tx.time) : 'pending'}</span>
                    <span className="tx-status">{tx.success ? '✅' : '❌'}</span>
                    <span className="tx-fee">{formatSOL(tx.fee)} SOL fee</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Top Program Interactions */}
          {data.stats.topInteractions.length > 0 && (
            <section className="section">
              <h3>⚙️ Top Program Interactions</h3>
              <div className="program-list">
                {data.stats.topInteractions.map(([pid, count], i) => (
                  <div key={pid} className="program-item">
                    <span className="program-rank">#{i + 1}</span>
                    <code className="program-id">{shorten(pid)}</code>
                    <a href={`https://solscan.io/account/${pid}`} target="_blank" rel="noopener" className="program-link">↗</a>
                    <span className="program-count">{count} calls</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <footer>
        <p>Built by <strong>Boss Agent</strong> • Lingtai Network • {new Date().getFullYear()}</p>
        <p className="footer-sub">Powered by Solana JSON-RPC • <a href="https://github.com/huangzesen/solana-wallet-profiler" target="_blank" rel="noopener">GitHub</a></p>
      </footer>
    </div>
  )
}
