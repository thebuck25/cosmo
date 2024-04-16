package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/99designs/gqlgen/graphql"
	"github.com/99designs/gqlgen/graphql/handler/debug"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/ravilushqa/otelgqlgen"
	"github.com/rs/cors"
	"github.com/wundergraph/cosmo/demo/pkg/otel"
	"github.com/wundergraph/cosmo/demo/pkg/subgraphs"
	"github.com/wundergraph/cosmo/demo/pkg/subgraphs/employees"
)

const (
	defaultPort = "4001"
	serviceName = "employees"
)

func main() {
	otel.InitTracing(context.Background(), otel.Options{ServiceName: serviceName})
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	srv := subgraphs.NewDemoServer(employees.NewSchema(nil))
	srv.Use(&debug.Tracer{})
	srv.Use(otelgqlgen.Middleware(otelgqlgen.WithCreateSpanFromFields(func(ctx *graphql.FieldContext) bool {
		return true
	})))

	c := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedHeaders: []string{"*"},
	})

	http.Handle("/", c.Handler(playground.Handler("GraphQL playground", "/graphql")))
	http.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {

		w.WriteHeader(http.StatusInternalServerError)
	})

	log.Printf("connect to http://localhost:%s/ for GraphQL playground", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
