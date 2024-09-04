// Code generated by protoc-gen-connect-go. DO NOT EDIT.
//
// Source: wg/cosmo/node/v1/node.proto

package nodev1connect

import (
	connect "connectrpc.com/connect"
	context "context"
	errors "errors"
	v1 "github.com/wundergraph/cosmo/terraform-provider-cosmo/gen/proto/wg/cosmo/node/v1"
	http "net/http"
	strings "strings"
)

// This is a compile-time assertion to ensure that this generated file and the connect package are
// compatible. If you get a compiler error that this constant is not defined, this code was
// generated with a version of connect newer than the one compiled into your binary. You can fix the
// problem by either regenerating this code with an older version of connect or updating the connect
// version compiled into your binary.
const _ = connect.IsAtLeastVersion1_13_0

const (
	// NodeServiceName is the fully-qualified name of the NodeService service.
	NodeServiceName = "wg.cosmo.node.v1.NodeService"
)

// These constants are the fully-qualified names of the RPCs defined in this package. They're
// exposed at runtime as Spec.Procedure and as the final two segments of the HTTP route.
//
// Note that these are different from the fully-qualified method names used by
// google.golang.org/protobuf/reflect/protoreflect. To convert from these constants to
// reflection-formatted method names, remove the leading slash and convert the remaining slash to a
// period.
const (
	// NodeServiceSelfRegisterProcedure is the fully-qualified name of the NodeService's SelfRegister
	// RPC.
	NodeServiceSelfRegisterProcedure = "/wg.cosmo.node.v1.NodeService/SelfRegister"
)

// These variables are the protoreflect.Descriptor objects for the RPCs defined in this package.
var (
	nodeServiceServiceDescriptor            = v1.File_wg_cosmo_node_v1_node_proto.Services().ByName("NodeService")
	nodeServiceSelfRegisterMethodDescriptor = nodeServiceServiceDescriptor.Methods().ByName("SelfRegister")
)

// NodeServiceClient is a client for the wg.cosmo.node.v1.NodeService service.
type NodeServiceClient interface {
	SelfRegister(context.Context, *connect.Request[v1.SelfRegisterRequest]) (*connect.Response[v1.SelfRegisterResponse], error)
}

// NewNodeServiceClient constructs a client for the wg.cosmo.node.v1.NodeService service. By
// default, it uses the Connect protocol with the binary Protobuf Codec, asks for gzipped responses,
// and sends uncompressed requests. To use the gRPC or gRPC-Web protocols, supply the
// connect.WithGRPC() or connect.WithGRPCWeb() options.
//
// The URL supplied here should be the base URL for the Connect or gRPC server (for example,
// http://api.acme.com or https://acme.com/grpc).
func NewNodeServiceClient(httpClient connect.HTTPClient, baseURL string, opts ...connect.ClientOption) NodeServiceClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &nodeServiceClient{
		selfRegister: connect.NewClient[v1.SelfRegisterRequest, v1.SelfRegisterResponse](
			httpClient,
			baseURL+NodeServiceSelfRegisterProcedure,
			connect.WithSchema(nodeServiceSelfRegisterMethodDescriptor),
			connect.WithClientOptions(opts...),
		),
	}
}

// nodeServiceClient implements NodeServiceClient.
type nodeServiceClient struct {
	selfRegister *connect.Client[v1.SelfRegisterRequest, v1.SelfRegisterResponse]
}

// SelfRegister calls wg.cosmo.node.v1.NodeService.SelfRegister.
func (c *nodeServiceClient) SelfRegister(ctx context.Context, req *connect.Request[v1.SelfRegisterRequest]) (*connect.Response[v1.SelfRegisterResponse], error) {
	return c.selfRegister.CallUnary(ctx, req)
}

// NodeServiceHandler is an implementation of the wg.cosmo.node.v1.NodeService service.
type NodeServiceHandler interface {
	SelfRegister(context.Context, *connect.Request[v1.SelfRegisterRequest]) (*connect.Response[v1.SelfRegisterResponse], error)
}

// NewNodeServiceHandler builds an HTTP handler from the service implementation. It returns the path
// on which to mount the handler and the handler itself.
//
// By default, handlers support the Connect, gRPC, and gRPC-Web protocols with the binary Protobuf
// and JSON codecs. They also support gzip compression.
func NewNodeServiceHandler(svc NodeServiceHandler, opts ...connect.HandlerOption) (string, http.Handler) {
	nodeServiceSelfRegisterHandler := connect.NewUnaryHandler(
		NodeServiceSelfRegisterProcedure,
		svc.SelfRegister,
		connect.WithSchema(nodeServiceSelfRegisterMethodDescriptor),
		connect.WithHandlerOptions(opts...),
	)
	return "/wg.cosmo.node.v1.NodeService/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case NodeServiceSelfRegisterProcedure:
			nodeServiceSelfRegisterHandler.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

// UnimplementedNodeServiceHandler returns CodeUnimplemented from all methods.
type UnimplementedNodeServiceHandler struct{}

func (UnimplementedNodeServiceHandler) SelfRegister(context.Context, *connect.Request[v1.SelfRegisterRequest]) (*connect.Response[v1.SelfRegisterResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("wg.cosmo.node.v1.NodeService.SelfRegister is not implemented"))
}
