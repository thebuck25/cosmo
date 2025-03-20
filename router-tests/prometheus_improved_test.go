package integration

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	io_prometheus_client "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/wundergraph/cosmo/router-tests/testenv"
	"go.opentelemetry.io/otel/sdk/metric"
)

// This file exists to be smaller than prometheus_test.go, and use better testing practices.
// Editors like Cursor, VSCode Copilot Agent, Zed, etc have a lot of trouble with the other file due
// to its size and testing methodology. In the new file, you should use new helpers where possible, and avoid
// asserting the values of unrelated metrics/labels.

func TestPrometheusImproved(t *testing.T) {
	t.Run("Collect and export schema usage metrics to Prometheus when enabled", func(t *testing.T) {
		t.Parallel()

		metricReader := metric.NewManualReader()
		promRegistry := prometheus.NewRegistry()

		testenv.Run(t, &testenv.Config{
			MetricReader:       metricReader,
			PrometheusRegistry: promRegistry,
			MetricOptions: testenv.MetricOptions{
				PromIncludeSchemaUsage: true,
			},
		}, func(t *testing.T, xEnv *testenv.Environment) {
			res := xEnv.MakeGraphQLRequestOK(testenv.GraphQLRequest{
				Query: `query myQuery { employee(id: 1) { id currentMood role { title } } }`,
			})
			require.JSONEq(t, `{"data":{"employee":{"id":1,"currentMood":"HAPPY","role":{"title":["Founder","CEO"]}}}}`, res.Body)

			mf, err := promRegistry.Gather()
			require.NoError(t, err)

			schemaUsage := findMetricFamilyByName(mf, "router_graphql_schema_field_usage_total")
			assert.NotNil(t, schemaUsage)

			schemaUsageMetrics := schemaUsage.GetMetric()

			require.Len(t, schemaUsageMetrics, 8)

			for _, metric := range schemaUsageMetrics {
				assertLabel(t, metric.Label, "wg_operation_name", "myQuery")
				assertLabel(t, metric.Label, "wg_operation_sha256", "f46b2e72054341523989a788e798ec5c922517e6106646120d2ff23984cfed4b")
				assertLabel(t, metric.Label, "wg_operation_type", "query")
			}

			assertLabel(t, schemaUsageMetrics[0].Label, "wg_field_name", "currentMood")
			assertLabel(t, schemaUsageMetrics[0].Label, "wg_type_name", "Employee")

			assertLabel(t, schemaUsageMetrics[1].Label, "wg_field_name", "employee")
			assertLabel(t, schemaUsageMetrics[1].Label, "wg_type_name", "Query")

			assertLabel(t, schemaUsageMetrics[2].Label, "wg_field_name", "id")
			assertLabel(t, schemaUsageMetrics[2].Label, "wg_type_name", "Employee")

			assertLabel(t, schemaUsageMetrics[3].Label, "wg_field_name", "role")
			assertLabel(t, schemaUsageMetrics[3].Label, "wg_type_name", "Employee")

			// 'role' is an interface, so it counts for each implementing type, and the interface itself
			assertLabel(t, schemaUsageMetrics[4].Label, "wg_field_name", "title")
			assertLabel(t, schemaUsageMetrics[4].Label, "wg_type_name", "Engineer")

			assertLabel(t, schemaUsageMetrics[5].Label, "wg_field_name", "title")
			assertLabel(t, schemaUsageMetrics[5].Label, "wg_type_name", "Marketer")

			assertLabel(t, schemaUsageMetrics[6].Label, "wg_field_name", "title")
			assertLabel(t, schemaUsageMetrics[6].Label, "wg_type_name", "Operator")

			assertLabel(t, schemaUsageMetrics[7].Label, "wg_field_name", "title")
			assertLabel(t, schemaUsageMetrics[7].Label, "wg_type_name", "RoleType")
		})
	})
}

func assertLabel(t *testing.T, labels []*io_prometheus_client.LabelPair, labelName string, expectedValue string) {
	t.Helper()

	var labelPair *io_prometheus_client.LabelPair

	for _, label := range labels {

		if label.Name != nil && *label.Name == labelName {
			labelPair = label
			break
		}
	}

	if assert.NotNil(t, labelPair, "label %s not found", labelName) {
		assert.Equal(t, expectedValue, *labelPair.Value, "label %s is not %s", labelName, expectedValue)
	}
}
