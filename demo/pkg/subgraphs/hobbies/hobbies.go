package hobbies

import (
	"github.com/99designs/gqlgen/graphql"
	"github.com/wundergraph/cosmo/router/pkg/pubsub/nats"

	"github.com/wundergraph/cosmo/demo/pkg/subgraphs/hobbies/subgraph"
	"github.com/wundergraph/cosmo/demo/pkg/subgraphs/hobbies/subgraph/generated"
)

func NewSchema(natsPubSubByProviderID map[string]*nats.NatsPubSub) graphql.ExecutableSchema {
	return generated.NewExecutableSchema(generated.Config{Resolvers: &subgraph.Resolver{
		NatsPubSubByProviderID: natsPubSubByProviderID,
	}})
}
