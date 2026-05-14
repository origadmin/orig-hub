package logging

import (
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
	"go.opentelemetry.io/otel/trace"
)

var (
	tpMu       sync.Mutex
	tpInstance *sdktrace.TracerProvider
)

func InitTracer(endpoint string, serviceName string) (func(context.Context) error, error) {
	if endpoint == "" {
		return func(ctx context.Context) error { return nil }, nil
	}

	exp, err := otlptracegrpc.New(context.Background(),
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
	}

	res, err := resource.Merge(
		resource.Default(),
		resource.NewSchemaless(
			semconv.ServiceNameKey.String(serviceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)

	tpMu.Lock()
	if tpInstance != nil {
		_ = tpInstance.Shutdown(context.Background())
	}
	tpInstance = tp
	tpMu.Unlock()

	otel.SetTracerProvider(tp)

	shutdown := func(ctx context.Context) error {
		tpMu.Lock()
		defer tpMu.Unlock()
		if tpInstance == nil {
			return nil
		}
		err := tpInstance.Shutdown(ctx)
		tpInstance = nil
		return err
	}

	return shutdown, nil
}

func StartSpan(ctx context.Context, name string) (context.Context, trace.Span) {
	return otel.Tracer("orig-hub").Start(ctx, name)
}

func SpanFromContext(ctx context.Context) trace.Span {
	return trace.SpanFromContext(ctx)
}

func AddEventToSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	if span.IsRecording() {
		span.AddEvent(name, trace.WithAttributes(attrs...))
	}
}
