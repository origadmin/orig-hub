package app

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpProto "github.com/origadmin/orig-hub/internal/protocol/http"
	"github.com/origadmin/orig-hub/internal/service"
)

func RunDaemon() {
	daemon := flag.Bool("daemon", false, "run in daemon mode")
	port := flag.Int("port", 9876, "daemon port")
	flag.Parse()

	if !*daemon {
		return
	}

	cfg, err := config.Load(config.ConfigFile())
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	registry := protocol.NewRegistry()
	p := httpProto.New(cfg.ToRuntimeConfig())
	if err := registry.Register(p); err != nil {
		log.Fatalf("register http protocol: %v", err)
	}

	db, err := state.Open(config.DBPath())
	if err != nil {
		log.Fatalf("open db: %v", err)
	}

	svc := service.NewLocalService(registry, cfg, db)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Starting daemon on %s", addr)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	<-sigCh
	log.Println("Shutting down daemon...")
	_ = svc.Shutdown()
}
