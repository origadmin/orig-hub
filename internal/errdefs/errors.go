package errdefs

import (
	"fmt"
)

type Error struct {
	Code    string
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	return e.Cause
}

func New(code, msg string) *Error {
	return &Error{
		Code:    code,
		Message: msg,
	}
}

func Wrap(err error, code, msg string) *Error {
	return &Error{
		Code:    code,
		Message: msg,
		Cause:   err,
	}
}

func IsCode(err error, code string) bool {
	if e, ok := err.(*Error); ok {
		return e.Code == code
	}
	return false
}

func GetCode(err error) string {
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	return ""
}
