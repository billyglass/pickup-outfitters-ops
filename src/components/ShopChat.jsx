import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { localDayStr, chatDayLabel, chatTime, validateChatDraft, isOwnMessage, CHAT_MAX_LENGTH } from '../lib/tickets.js'

// Shop-wide message board on the dashboard, iMessage-style: own
// messages on the right in blue, everyone else's on the left in gray
// with their name above the bubble, newest at the bottom. No private
// messages in v1. Anyone signed in can post; a user can delete their
// own messages and Admin can delete anyone's. Polls every 20 seconds
// (no Realtime in v1). Until migration 022 runs live the table does
// not exist — the load fails, the chat shows a not-set-up note and the
// input stays disabled instead of crashing anything.
export default function ShopChat({ data, user, isAdmin, hasNewChat, onChatSeen }) {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notReady, setNotReady] = useState(false)
  const [sending, setSending] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [visibleTick, setVisibleTick] = useState(0)
  const listRef = useRef(null)

  async function load() {
    try {
      const rows = await store.listMessages(50)
      setMessages(rows)
      setNotReady(false)
    } catch (err) {
      // Table missing (pre-migration) or offline — stay quiet and retry
      // on the next poll instead of erroring the whole dashboard.
      setNotReady(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // New-message dot: mark the board seen so the dot clears. Only runs
  // while this component is mounted — i.e. while the dashboard tab is
  // open and the chat is on screen. Fails silently pre-migration 023
  // (the function does not exist yet) and the dot just stays until the
  // migration runs; onChatSeen is only called when the mark stuck.
  async function markSeen() {
    if (!user?.id) return
    const ok = await store.markChatSeen(user.id)
    if (ok) onChatSeen?.()
  }

  // Latest other-authored message time — the timer re-arms whenever a
  // newer one arrives (a plain string dep, so equal values don't re-arm).
  const latestOtherAt = useMemo(() => {
    const others = (messages || []).filter((m) => !isOwnMessage(m, user?.id))
    if (!others.length) return null
    return others.map((m) => m.created_at).sort().pop() || null
  }, [messages, user?.id])

  // When there is a new message and the browser tab is visible, wait
  // 10 seconds (the user is looking at the board), then mark seen.
  // Re-arms when a newer message arrives; clears when the tab hides or
  // the dot goes away. Never marks seen while the tab is hidden.
  useEffect(() => {
    if (!hasNewChat || document.visibilityState !== 'visible') return undefined
    const t = setTimeout(() => { markSeen() }, 10000)
    return () => clearTimeout(t)
  }, [hasNewChat, latestOtherAt, visibleTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tab becomes visible again with a new message waiting: re-arm the
  // timer above. (visibilitychange to hidden also bumps the tick, which
  // re-runs the timer effect and clears it — nothing marks while hidden.)
  useEffect(() => {
    function onVis() { setVisibleTick((n) => n + 1) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const authorName = (id) => (data?.profiles || []).find((p) => p.id === id)?.name || 'Unknown'
  const today = localDayStr(new Date().toISOString())
  const canPost = !!user?.id && !notReady

  async function send() {
    const problem = validateChatDraft(draft)
    if (problem) { setError(problem); return }
    if (!user?.id) { setError('Sign in to post a message.'); return }
    setError('')
    setSending(true)
    try {
      const saved = await store.postMessage(draft, user.id)
      setMessages((ms) => [...ms, saved])
      setDraft('')
      // Posting means you just read the board — mark it seen.
      markSeen()
    } catch (err) {
      setError(err.message || 'Could not send message.')
    } finally {
      setSending(false)
    }
  }

  async function remove(msg) {
    setError('')
    try {
      await store.deleteMessage(msg.id, user?.id, isAdmin)
      setMessages((ms) => ms.filter((m) => m.id !== msg.id))
      setConfirmDeleteId(null)
    } catch (err) {
      setError(err.message || 'Delete failed.')
    }
  }

  return (
    <div className="card chat-card">
      <h2 style={{ marginTop: 0 }}>Shop chat{hasNewChat && <span className="chat-dot" title="New message" />}</h2>
      <p className="muted small">Shop-wide board — everyone signed in can see and post here. No private messages.</p>
      {loading ? (
        <p className="muted">Loading messages…</p>
      ) : (
        <>
          {notReady && (
            <p className="muted">Shop chat is not set up yet — the messages table has not been created. It will start working on its own once the setup runs; nothing else is affected.</p>
          )}
          <div className="chat-list" ref={listRef}>
            {!notReady && messages.length === 0 && <p className="muted">No messages yet — say hello to the shop.</p>}
            {!notReady && messages.map((m, i) => {
              const day = localDayStr(m.created_at)
              const prevDay = i > 0 ? localDayStr(messages[i - 1].created_at) : null
              const mine = isOwnMessage(m, user?.id)
              const canDelete = mine || isAdmin
              return (
                <Fragment key={m.id}>
                  {day !== prevDay && <div className="chat-day">{chatDayLabel(day, today)}</div>}
                  <div className={`chat-msg${mine ? ' mine' : ''}`}>
                    {!mine && <div className="chat-name">{authorName(m.author_id)}</div>}
                    <div className="chat-bubble">
                      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</span>
                      {canDelete && confirmDeleteId === m.id ? (
                        <span className="chat-confirm">
                          {' '}Delete?{' '}
                          <button type="button" onClick={() => remove(m)}>Yes</button>{' '}
                          <button type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        </span>
                      ) : canDelete ? (
                        <button type="button" className="chat-delete" onClick={() => setConfirmDeleteId(m.id)} title="Delete message">×</button>
                      ) : null}
                    </div>
                    <div className="chat-time">{chatTime(m.created_at)}</div>
                  </div>
                </Fragment>
              )
            })}
          </div>
          <div className="chat-input-row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              placeholder={canPost ? 'Message the shop…' : 'Shop chat is not set up yet.'}
              maxLength={CHAT_MAX_LENGTH}
              disabled={sending || !canPost}
            />
            <button className="btn" type="button" disabled={sending || !canPost || !draft.trim()} onClick={send}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  )
}
