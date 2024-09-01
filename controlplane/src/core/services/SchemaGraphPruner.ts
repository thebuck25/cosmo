import { GraphQLSchema, isInputObjectType, isInterfaceType, isObjectType } from 'graphql';
import { LintSeverity } from '@wundergraph/cosmo-connect/dist/platform/v1/platform_pb';
import {
  FederatedGraphDTO,
  Field,
  GraphPruningIssueResult,
  LintSeverityLevel,
  SchemaGraphPruningDTO,
  SchemaGraphPruningIssues,
  SubgraphDTO,
} from '../../types/index.js';
import { SchemaDiff } from '../composition/schemaCheck.js';
import { SubgraphRepository } from '../repositories/SubgraphRepository.js';
import { UsageRepository } from '../repositories/analytics/UsageRepository.js';
import { FederatedGraphRepository } from '../repositories/FederatedGraphRepository.js';

export default class SchemaGraphPruner {
  constructor(
    private federatedGraphRepo: FederatedGraphRepository,
    private subgraphRepo: SubgraphRepository,
    private usageRepo: UsageRepository,
    private schema: GraphQLSchema,
  ) {}

  getAllFields = ({ onlyDeprecated }: { onlyDeprecated?: boolean }): Field[] => {
    const fields: Field[] = [];

    const types = this.schema.getTypeMap();

    for (const typeName in types) {
      const type = types[typeName];
      if (typeName.startsWith('__')) {
        continue;
      }

      if (!isObjectType(type) && !isInterfaceType(type) && !isInputObjectType(type)) {
        continue;
      }

      const fieldMap = type.getFields();

      for (const fieldName in fieldMap) {
        const field = fieldMap[fieldName];
        if (onlyDeprecated && !field.deprecationReason) {
          continue;
        }
        fields.push({
          name: field.name,
          typeName,
          path: `${typeName}.${field.name}`,
          location: {
            line: field.astNode?.name.loc?.startToken.line,
            column: field.astNode?.name.loc?.startToken.column,
            endLine: field.astNode?.name.loc?.endToken.line,
            endColumn: field.astNode?.name.loc?.endToken.column,
          },
          isDeprecated: !!field.deprecationReason,
        });
      }
    }

    return fields;
  };

  fetchUnusedFields = async ({
    subgraphId,
    namespaceId,
    organizationId,
    federatedGraphs,
    rangeInDays,
    addedFields,
    severityLevel,
  }: {
    federatedGraphs: FederatedGraphDTO[];
    subgraphId: string;
    namespaceId: string;
    organizationId: string;
    rangeInDays: number;
    // fields that were added in the proposed schema passed to the check command
    addedFields: SchemaDiff[];
    severityLevel: LintSeverityLevel;
  }): Promise<GraphPruningIssueResult[]> => {
    const allFields = this.getAllFields({});
    const fieldsInGracePeriod = await this.subgraphRepo.getSubgraphFieldsInGracePeriod({ subgraphId, namespaceId });

    const fieldsToBeChecked = allFields.filter((field) => {
      return !fieldsInGracePeriod.some((f) => f.path === field.path) && !addedFields.some((f) => f.path === field.path);
    });

    const graphPruningIssues: GraphPruningIssueResult[] = [];

    for (const federatedGraph of federatedGraphs) {
      const unusedFieldsWithTypeNames = await this.usageRepo.getUnusedFields({
        fields: fieldsToBeChecked,
        organizationId,
        federatedGraphId: federatedGraph.id,
        range: rangeInDays * 24,
      });
      const unusedFields = allFields.filter((field) =>
        unusedFieldsWithTypeNames.some((f) => f.name === field.name && f.typeName === field.typeName),
      );
      for (const field of unusedFields) {
        graphPruningIssues.push({
          graphPruningRuleType: 'UNUSED_FIELDS',
          severity: severityLevel === 'error' ? LintSeverity.error : LintSeverity.warn,
          fieldPath: field.path,
          message: `Field ${field.name} of type ${field.typeName} has not used in the past ${rangeInDays} days`,
          issueLocation: {
            line: field.location.line || 0,
            column: field.location.column || 0,
            endLine: field.location.endLine,
            endColumn: field.location.endColumn,
          },
          federatedGraphId: federatedGraph.id,
          federatedGraphName: federatedGraph.name,
        });
      }
    }

    return graphPruningIssues;
  };

  fetchDeprecatedFields = async ({
    subgraphId,
    namespaceId,
    organizationId,
    federatedGraphs,
    rangeInDays,
    severityLevel,
    addedDeprecatedFields,
  }: {
    federatedGraphs: FederatedGraphDTO[];
    subgraphId: string;
    namespaceId: string;
    organizationId: string;
    rangeInDays: number;
    severityLevel: LintSeverityLevel;
    addedDeprecatedFields: SchemaDiff[];
  }): Promise<GraphPruningIssueResult[]> => {
    const allDeprecatedFields = this.getAllFields({ onlyDeprecated: true });
    const deprecatedFieldsInGracePeriod = await this.subgraphRepo.getSubgraphFieldsInGracePeriod({
      subgraphId,
      namespaceId,
      onlyDeprecated: true,
    });

    const deprecatedFieldsToBeChecked = allDeprecatedFields.filter((field) => {
      return (
        !deprecatedFieldsInGracePeriod.some((f) => f.path === field.path) &&
        !addedDeprecatedFields.some((f) => f.path === field.path)
      );
    });

    if (deprecatedFieldsToBeChecked.length === 0) {
      return [];
    }

    const graphPruningIssues: GraphPruningIssueResult[] = [];

    for (const federatedGraph of federatedGraphs) {
      const usedDeprecatedFieldsWithTypeNames = await this.usageRepo.getUsedFields({
        fields: deprecatedFieldsToBeChecked,
        organizationId,
        federatedGraphId: federatedGraph.id,
        range: rangeInDays * 24,
      });

      for (const field of deprecatedFieldsToBeChecked) {
        const isUsed = usedDeprecatedFieldsWithTypeNames.some(
          (f) => f.name === field.name && f.typeName === field.typeName,
        );
        graphPruningIssues.push({
          graphPruningRuleType: 'DEPRECATED_FIELDS',
          severity: severityLevel === 'error' ? LintSeverity.error : LintSeverity.warn,
          fieldPath: field.path,
          message: isUsed
            ? `Field ${field.name} of type ${field.typeName} was deprecated, but is still in use despite the expiration of the grace period.`
            : `Field ${field.name} of type ${field.typeName} was deprecated, is no longer in use, and is now safe for removal following the expiration of the grace period.`,
          issueLocation: {
            line: field.location.line || 0,
            column: field.location.column || 0,
            endLine: field.location.endLine,
            endColumn: field.location.endColumn,
          },
          federatedGraphId: federatedGraph.id,
          federatedGraphName: federatedGraph.name,
        });
      }
    }

    return graphPruningIssues;
  };

  schemaGraphPruneCheck = async ({
    subgraph,
    graphPruningConfigs,
    organizationId,
    rangeInDays,
    updatedFields,
  }: {
    subgraph: SubgraphDTO;
    graphPruningConfigs: SchemaGraphPruningDTO[];
    organizationId: string;
    rangeInDays: number;
    // fields that were added/updated in the proposed schema passed to the check command
    updatedFields: SchemaDiff[];
  }): Promise<SchemaGraphPruningIssues> => {
    const graphPruneWarnings: GraphPruningIssueResult[] = [];
    const graphPruneErrors: GraphPruningIssueResult[] = [];

    const federatedGraphs = await this.federatedGraphRepo.bySubgraphLabels({
      labels: subgraph.labels,
      namespaceId: subgraph.namespaceId,
      excludeContracts: false,
    });

    for (const graphPruningConfig of graphPruningConfigs) {
      const { ruleName, severity } = graphPruningConfig;

      if (ruleName === 'UNUSED_FIELDS') {
        const unusedFields = await this.fetchUnusedFields({
          subgraphId: subgraph.id,
          namespaceId: subgraph.namespaceId,
          organizationId,
          federatedGraphs,
          rangeInDays,
          addedFields: updatedFields.filter((field) => field.changeType !== 'FIELD_DEPRECATION_ADDED'),
          severityLevel: severity,
        });

        if (severity === 'error') {
          graphPruneErrors.push(...unusedFields);
        } else {
          graphPruneWarnings.push(...unusedFields);
        }
      } else if (ruleName === 'DEPRECATED_FIELDS') {
        const deprecatedFields = await this.fetchDeprecatedFields({
          subgraphId: subgraph.id,
          namespaceId: subgraph.namespaceId,
          organizationId,
          federatedGraphs,
          rangeInDays,
          severityLevel: severity,
          addedDeprecatedFields: updatedFields.filter((field) => field.changeType === 'FIELD_DEPRECATION_ADDED'),
        });

        if (severity === 'error') {
          graphPruneErrors.push(...deprecatedFields);
        } else {
          graphPruneWarnings.push(...deprecatedFields);
        }
      }
    }

    return {
      warnings: graphPruneWarnings,
      errors: graphPruneErrors,
    };
  };
}
