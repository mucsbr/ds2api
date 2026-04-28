package account

import (
	"context"

	"ds2api/internal/config"
)

func (p *Pool) Acquire(target string, exclude map[string]bool) (config.Account, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.acquireLocked(target, normalizeExclude(exclude))
}

func (p *Pool) AcquireWait(ctx context.Context, target string, exclude map[string]bool) (config.Account, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	exclude = normalizeExclude(exclude)
	for {
		if err := ctx.Err(); err != nil {
			config.Logger.Warn("[account_pool] acquire wait aborted before lock",
				"target", target,
				"exclude_count", len(exclude),
				"reason", err,
			)
			return config.Account{}, false
		}

		p.mu.Lock()
		if acc, ok := p.acquireLocked(target, exclude); ok {
			config.Logger.Debug("[account_pool] acquire wait success",
				"account", acc.Identifier(),
				"target", target,
				"exclude_count", len(exclude),
				"in_use", p.currentInUseLocked(),
				"waiting", len(p.waiters),
				"available_after", p.availableCountLocked(),
			)
			p.mu.Unlock()
			return acc, true
		}
		if !p.canQueueLocked(target, exclude) {
			reason := p.queueBlockReasonLocked(target, exclude)
			config.Logger.Warn("[account_pool] acquire wait rejected",
				"target", target,
				"exclude_count", len(exclude),
				"reason", reason,
				"in_use", p.currentInUseLocked(),
				"waiting", len(p.waiters),
				"available", p.availableCountLocked(),
				"total", len(p.queue),
				"max_inflight_per_account", p.maxInflightPerAccount,
				"global_max_inflight", p.globalMaxInflight,
				"max_queue_size", p.maxQueueSize,
			)
			p.mu.Unlock()
			return config.Account{}, false
		}
		waiter := make(chan struct{})
		p.waiters = append(p.waiters, waiter)
		config.Logger.Debug("[account_pool] acquire wait queued",
			"target", target,
			"exclude_count", len(exclude),
			"waiting", len(p.waiters),
			"in_use", p.currentInUseLocked(),
			"available", p.availableCountLocked(),
		)
		p.mu.Unlock()

		select {
		case <-ctx.Done():
			p.mu.Lock()
			removed := p.removeWaiterLocked(waiter)
			config.Logger.Warn("[account_pool] acquire wait canceled",
				"target", target,
				"exclude_count", len(exclude),
				"removed_from_queue", removed,
				"reason", ctx.Err(),
				"waiting", len(p.waiters),
				"in_use", p.currentInUseLocked(),
				"available", p.availableCountLocked(),
			)
			p.mu.Unlock()
			return config.Account{}, false
		case <-waiter:
		}
	}
}

func (p *Pool) acquireLocked(target string, exclude map[string]bool) (config.Account, bool) {
	if target != "" {
		if exclude[target] || !p.canAcquireIDLocked(target) {
			return config.Account{}, false
		}
		acc, ok := p.store.FindAccount(target)
		if !ok {
			return config.Account{}, false
		}
		p.inUse[target]++
		p.bumpQueue(target)
		return acc, true
	}

	return p.tryAcquire(exclude)
}

func (p *Pool) tryAcquire(exclude map[string]bool) (config.Account, bool) {
	for i := 0; i < len(p.queue); i++ {
		id := p.queue[i]
		if exclude[id] || !p.canAcquireIDLocked(id) {
			continue
		}
		acc, ok := p.store.FindAccount(id)
		if !ok {
			continue
		}
		p.inUse[id]++
		p.bumpQueue(id)
		return acc, true
	}
	return config.Account{}, false
}

func (p *Pool) bumpQueue(accountID string) {
	for i, id := range p.queue {
		if id != accountID {
			continue
		}
		p.queue = append(p.queue[:i], p.queue[i+1:]...)
		p.queue = append(p.queue, accountID)
		return
	}
}

func normalizeExclude(exclude map[string]bool) map[string]bool {
	if exclude == nil {
		return map[string]bool{}
	}
	return exclude
}
