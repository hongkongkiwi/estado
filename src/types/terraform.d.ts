// LockInfo stores lock metadata.
//
// Terraform sends all of the metadata fields below. Estado validates each
// field and caps its size before storing the lock in Durable Object storage.
export interface LockInfo {
	// Unique ID for the lock. newLockInfo provides a random ID, but this may
	// be overridden by the lock implementation. The final value of ID will be
	// returned by the call to Lock.
	ID: string;

	// Terraform operation, provided by the caller.
	operation?: string;
	Operation?: string;

	// Extra information to store with the lock, provided by the caller.
	info?: string;
	Info?: string;

	// user@hostname when available
	who?: string;
	Who?: string;

	// Terraform version
	version?: string;
	Version?: string;

	// Time that the lock was taken.
	created?: Date | string;
	Created?: Date | string;

	// Path to the state file when applicable. Set by the Lock implementation.
	path?: string;
	Path?: string;
}
