package errdefs

import (
	"errors"
)

type withProtocol struct {
	cause    error
	protocol string
}

func (w *withProtocol) Error() string {
	return w.cause.Error() + ": protocol=" + w.protocol
}

func (w *withProtocol) Unwrap() error {
	return w.cause
}

func (w *withProtocol) Protocol() string {
	return w.protocol
}

func WithProtocol(err error, protocol string) error {
	if err == nil {
		return nil
	}
	return &withProtocol{cause: err, protocol: protocol}
}

type withDownloadID struct {
	cause error
	id    string
}

func (w *withDownloadID) Error() string {
	return w.cause.Error() + ": download_id=" + w.id
}

func (w *withDownloadID) Unwrap() error {
	return w.cause
}

func (w *withDownloadID) DownloadID() string {
	return w.id
}

func WithDownloadID(err error, id string) error {
	if err == nil {
		return nil
	}
	return &withDownloadID{cause: err, id: id}
}

type withURL struct {
	cause error
	url   string
}

func (w *withURL) Error() string {
	return w.cause.Error() + ": url=" + w.url
}

func (w *withURL) Unwrap() error {
	return w.cause
}

func (w *withURL) URL() string {
	return w.url
}

func WithURL(err error, url string) error {
	if err == nil {
		return nil
	}
	return &withURL{cause: err, url: url}
}

type withRetry struct {
	cause   error
	attempt int
}

func (w *withRetry) Error() string {
	return w.cause.Error() + ": retry=" + itoa(w.attempt)
}

func (w *withRetry) Unwrap() error {
	return w.cause
}

func (w *withRetry) Attempt() int {
	return w.attempt
}

func WithRetry(err error, attempt int) error {
	if err == nil {
		return nil
	}
	return &withRetry{cause: err, attempt: attempt}
}

func UnwrapAll(err error) error {
	for {
		unwrapped := errors.Unwrap(err)
		if unwrapped == nil {
			return err
		}
		err = unwrapped
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte(n%10) + '0'
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
