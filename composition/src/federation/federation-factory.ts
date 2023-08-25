import { MultiGraph } from 'graphology';
import { allSimplePaths } from 'graphology-simple-path';
import {
  buildASTSchema,
  ConstValueNode,
  DirectiveDefinitionNode,
  DocumentNode,
  EnumValueDefinitionNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  Kind,
  NamedTypeNode,
  ObjectTypeDefinitionNode,
  ObjectTypeExtensionNode,
  TypeDefinitionNode,
  UnionTypeDefinitionNode,
} from 'graphql';
import {
  ConstValueNodeWithValue,
  enumTypeDefinitionNodeToMutable,
  enumValueDefinitionNodeToMutable,
  fieldDefinitionNodeToMutable,
  inputObjectTypeDefinitionNodeToMutable,
  inputValueDefinitionNodeToMutable,
  interfaceTypeDefinitionNodeToMutable,
  MutableTypeDefinitionNode,
  objectTypeDefinitionNodeToMutable,
  objectTypeExtensionNodeToMutable,
  objectTypeExtensionNodeToMutableDefinitionNode,
  scalarTypeDefinitionNodeToMutable,
  unionTypeDefinitionNodeToMutable,
} from '../ast/ast';
import {
  ArgumentContainer,
  ArgumentMap,
  EntityContainer,
  EnumValueContainer,
  ExtensionContainer,
  extractEntityKeys,
  extractInterfaces,
  FieldContainer,
  getInlineFragmentString,
  InputValueContainer,
  InterfaceContainer,
  isNodeShareable,
  MergeMethod,
  ObjectContainer,
  ObjectExtensionContainer,
  ObjectLikeContainer,
  ParentContainer,
  ParentMap,
  PotentiallyUnresolvableField,
  RootTypeField,
  stringToNamedTypeNode,
} from '../ast/utils';
import {
  argumentTypeMergeFatalError,
  federationInvalidParentTypeError,
  federationRequiredInputFieldError,
  fieldTypeMergeFatalError,
  incompatibleArgumentDefaultValueError,
  incompatibleArgumentDefaultValueTypeError,
  incompatibleArgumentTypesError,
  incompatibleChildTypesError,
  incompatibleParentKindFatalError,
  incompatibleSharedEnumError,
  invalidMultiGraphNodeFatalError,
  invalidRequiredArgumentsError,
  invalidSubgraphNameErrorMessage,
  invalidSubgraphNamesError,
  invalidUnionError,
  minimumSubgraphRequirementError,
  noBaseTypeExtensionError,
  noQueryRootTypeError,
  shareableFieldDefinitionsError,
  subgraphValidationError,
  subgraphValidationFailureErrorMessage,
  unexpectedArgumentKindFatalError,
  unexpectedKindFatalError,
  unimplementedInterfaceFieldsError,
  unresolvableFieldError,
} from '../errors/errors';
import {
  getLeastRestrictiveMergedTypeNode,
  getMostRestrictiveMergedTypeNode,
  getNamedTypeForChild,
  isTypeRequired,
} from '../type-merging/type-merging';
import { FederationResultContainer } from './federation-result';
import {
  InternalSubgraph,
  Subgraph,
  validateSubgraphName,
  walkSubgraphToCollectObjects,
  walkSubgraphToCollectOperationsAndFields,
  walkSubgraphToFederate,
} from '../subgraph/subgraph';
import {
  DEFAULT_MUTATION,
  DEFAULT_QUERY,
  DEFAULT_SUBSCRIPTION,
  FIELD_NAME,
  INLINE_FRAGMENT,
  QUERY,
} from '../utils/string-constants';
import {
  doSetsHaveAnyOverlap,
  getEntriesNotInHashSet,
  getOrThrowError,
  ImplementationErrors,
  InvalidFieldImplementation,
  InvalidRequiredArgument,
  isTypeValidImplementation,
  kindToTypeString,
} from '../utils/utils';
import { normalizeSubgraph } from '../normalization/normalization-factory';
import { printTypeNode } from '@graphql-tools/merge';
import { ArgumentConfigurationData } from '../subgraph/field-configuration';

export function federateSubgraphs(subgraphs: Subgraph[]): FederationResultContainer {
  if (subgraphs.length < 1) {
    throw minimumSubgraphRequirementError;
  }
  const normalizedSubgraphs: InternalSubgraph[] = [];
  const validationErrors: Error[] = [];
  const subgraphNames = new Set<string>();
  const nonUniqueSubgraphNames = new Set<string>();
  const invalidNameErrorMessages: string[] = [];
  for (let i = 0; i < subgraphs.length; i++) {
    const subgraph = subgraphs[i];
    const name = subgraph.name || `subgraph-${i}-${Date.now()}`;
    if (!subgraph.name) {
      invalidNameErrorMessages.push(invalidSubgraphNameErrorMessage(i, name));
    } else {
      validateSubgraphName(subgraph.name, subgraphNames, nonUniqueSubgraphNames);
    }
    const { errors, normalizationResult } = normalizeSubgraph(subgraph.definitions);
    if (errors) {
      validationErrors.push(subgraphValidationError(name, errors));
      continue;
    }
    if (!normalizationResult) {
      validationErrors.push(subgraphValidationError(name, [subgraphValidationFailureErrorMessage]));
      continue;
    }
    normalizedSubgraphs.push({
      definitions: normalizationResult.subgraphAST,
      isVersionTwo: normalizationResult.isVersionTwo,
      name,
      operationTypes: normalizationResult.operationTypes,
      url: subgraph.url,
    });
  }
  const allErrors: Error[] = [];
  if (invalidNameErrorMessages.length > 0 || nonUniqueSubgraphNames.size > 0) {
    allErrors.push(invalidSubgraphNamesError([...nonUniqueSubgraphNames], invalidNameErrorMessages));
  }
  allErrors.push(...validationErrors);
  if (allErrors.length > 0) {
    return { errors: allErrors };
  }
  const federationFactory = new FederationFactory(normalizedSubgraphs);
  return federationFactory.federate();
}

export class FederationFactory {
  abstractToConcreteTypeNames = new Map<string, Set<string>>();
  areFieldsShareable = false;
  argumentTypeNameSet = new Set<string>();
  argumentConfigurations: ArgumentConfigurationData[] = [];
  parentTypeName = '';
  currentSubgraphName = '';
  childName = '';
  directiveDefinitions = new Map<string, DirectiveDefinitionNode>();
  entityMap = new Map<string, EntityContainer>();
  errors: Error[] = [];
  extensions = new Map<string, ExtensionContainer>();
  graph: MultiGraph = new MultiGraph();
  graphEdges = new Set<string>();
  inputFieldTypeNameSet = new Set<string>();
  isCurrentParentEntity = false;
  isCurrentParentInterface = false;
  isCurrentSubgraphVersionTwo = false;
  isCurrentParentExtensionType = false;
  isParentRootType = false;
  isParentInputObject = false;
  outputFieldTypeNameSet = new Set<string>();
  parentMap: ParentMap = new Map<string, ParentContainer>();
  rootTypeFieldsByResponseTypeName = new Map<string, Map<string, RootTypeField>>();
  rootTypeNames = new Set<string>([DEFAULT_MUTATION, DEFAULT_QUERY, DEFAULT_SUBSCRIPTION]);
  sharedRootTypeFieldDependentResponses = new Map<string, PotentiallyUnresolvableField[]>();
  subgraphs: InternalSubgraph[] = [];
  shareableErrorTypeNames = new Map<string, Set<string>>();

  constructor(subgraphs: InternalSubgraph[]) {
    this.subgraphs = subgraphs;
  }

  isObjectRootType(node: ObjectTypeDefinitionNode | ObjectTypeExtensionNode): boolean {
    return this.rootTypeNames.has(node.name.value);
  }

  upsertEntity(node: ObjectTypeDefinitionNode | ObjectTypeExtensionNode) {
    const typeName = node.name.value;
    const entity = this.entityMap.get(typeName);
    if (entity) {
      extractEntityKeys(node, entity.keys);
      entity.subgraphs.add(this.currentSubgraphName);
      return;
    }
    this.entityMap.set(typeName, {
      fields: new Set<string>(),
      keys: extractEntityKeys(node, new Set<string>()),
      subgraphs: new Set<string>([this.currentSubgraphName]),
    });
  }

  populateMultiGraphAndRenameOperations(subgraphs: InternalSubgraph[]) {
    for (const subgraph of subgraphs) {
      this.currentSubgraphName = subgraph.name;
      walkSubgraphToCollectObjects(this, subgraph);
      walkSubgraphToCollectOperationsAndFields(this, subgraph);
    }
  }

  isFieldEntityKey(parent: ParentContainer | ExtensionContainer): boolean {
    if (parent.kind === Kind.OBJECT_TYPE_DEFINITION || parent.kind === Kind.OBJECT_TYPE_EXTENSION) {
      return parent.entityKeys.has(this.childName);
    }
    return false;
  }

  getEnumMergeMethod(enumName: string): MergeMethod {
    if (this.inputFieldTypeNameSet.has(enumName) || this.argumentTypeNameSet.has(enumName)) {
      if (this.outputFieldTypeNameSet.has(enumName)) {
        return MergeMethod.CONSISTENT;
      }
      return MergeMethod.INTERSECTION;
    }
    return MergeMethod.UNION;
  }

  validateArgumentDefaultValues(
    argName: string,
    existingDefaultValue: ConstValueNodeWithValue,
    newDefaultValue: ConstValueNode,
  ) {
    if (existingDefaultValue.kind !== newDefaultValue.kind) {
      // This should be caught by subgraph validation
      this.errors.push(
        incompatibleArgumentDefaultValueTypeError(
          argName,
          this.parentTypeName,
          this.childName,
          existingDefaultValue.kind,
          newDefaultValue.kind,
        ),
      );
    }
    if ('value' in newDefaultValue && existingDefaultValue.value !== newDefaultValue.value) {
      this.errors.push(
        incompatibleArgumentDefaultValueError(
          argName,
          this.parentTypeName,
          this.childName,
          existingDefaultValue.value,
          newDefaultValue.value,
        ),
      );
    }
  }

  compareAndValidateArgumentDefaultValues(existingArg: ArgumentContainer, newArg: InputValueDefinitionNode) {
    const newDefaultValue = newArg.defaultValue;
    existingArg.node.defaultValue = existingArg.node.defaultValue || newDefaultValue;
    if (!existingArg.node.defaultValue || !newDefaultValue) {
      existingArg.includeDefaultValue = false;
      return;
    }
    const argumentName = existingArg.node.name.value;
    const existingDefaultValue = existingArg.node.defaultValue;
    switch (existingDefaultValue.kind) {
      case Kind.LIST: // TODO
        break;
      case Kind.NULL:
        break;
      case Kind.OBJECT:
        break;
      // BOOLEAN, ENUM, FLOAT, INT, and STRING purposely fall through
      case Kind.BOOLEAN:
      case Kind.ENUM:
      case Kind.FLOAT:
      case Kind.INT:
      case Kind.STRING:
        this.validateArgumentDefaultValues(argumentName, existingDefaultValue, newDefaultValue);
        break;
      default:
        throw unexpectedArgumentKindFatalError(argumentName, this.childName);
    }
  }

  upsertRequiredSubgraph(set: Set<string>, isRequired: boolean): Set<string> {
    if (isRequired) {
      set.add(this.currentSubgraphName);
    }
    return set;
  }

  // TODO validation of default values
  upsertArgumentsForFieldNode(node: FieldDefinitionNode, existingFieldNode: FieldContainer) {
    if (!node.arguments) {
      return;
    }
    for (const arg of node.arguments) {
      const argName = arg.name.value;
      const argPath = `${node.name.value}(${argName}...)`;
      this.argumentTypeNameSet.add(getNamedTypeForChild(argPath, arg.type));
      const isRequired = isTypeRequired(arg.type);
      const existingArg = existingFieldNode.arguments.get(argName);
      if (!existingArg) {
        existingFieldNode.arguments.set(argName, {
          includeDefaultValue: !!arg.defaultValue,
          node: inputValueDefinitionNodeToMutable(arg, this.childName),
          requiredSubgraphs: this.upsertRequiredSubgraph(new Set<string>(), isRequired),
          subgraphs: new Set<string>([this.currentSubgraphName]),
        });
        continue;
      }
      existingArg.node.description = existingArg.node.description || arg.description;
      this.upsertRequiredSubgraph(existingArg.requiredSubgraphs, isRequired);
      existingArg.subgraphs.add(this.currentSubgraphName);
      const { typeErrors, typeNode } = getMostRestrictiveMergedTypeNode(
        existingArg.node.type,
        arg.type,
        this.childName,
        argName,
      );
      if (typeNode) {
        existingArg.node.type = typeNode;
      } else {
        if (!typeErrors || typeErrors.length < 2) {
          throw argumentTypeMergeFatalError(argName, this.childName);
        }
        this.errors.push(
          incompatibleArgumentTypesError(argName, this.parentTypeName, this.childName, typeErrors[0], typeErrors[1]),
        );
      }
      this.compareAndValidateArgumentDefaultValues(existingArg, arg);
    }
  }

  extractArgumentsFromFieldNode(node: FieldDefinitionNode, args: ArgumentMap): ArgumentMap {
    if (!node.arguments) {
      return args;
    }
    for (const arg of node.arguments) {
      const argName = arg.name.value;
      const argPath = `${node.name.value}(${argName}...)`;
      args.set(argName, {
        includeDefaultValue: !!arg.defaultValue,
        node: inputValueDefinitionNodeToMutable(arg, this.childName),
        requiredSubgraphs: this.upsertRequiredSubgraph(new Set<string>(), isTypeRequired(arg.type)),
        subgraphs: new Set<string>([this.currentSubgraphName]),
      });
      this.argumentTypeNameSet.add(getNamedTypeForChild(argPath, arg.type));
    }
    return args;
  }

  addConcreteTypesForInterface(node: ObjectTypeDefinitionNode | ObjectTypeExtensionNode | InterfaceTypeDefinitionNode) {
    if (!node.interfaces || node.interfaces.length < 1) {
      return;
    }
    const concreteTypeName = node.name.value;
    for (const iFace of node.interfaces) {
      const interfaceName = iFace.name.value;
      const concreteTypes = this.abstractToConcreteTypeNames.get(interfaceName);
      if (concreteTypes) {
        concreteTypes.add(concreteTypeName);
      } else {
        this.abstractToConcreteTypeNames.set(interfaceName, new Set<string>([concreteTypeName]));
      }
    }
  }

  addConcreteTypesForUnion(node: UnionTypeDefinitionNode) {
    if (!node.types || node.types.length < 1) {
      return;
    }
    const unionName = node.name.value;
    for (const member of node.types) {
      const memberName = member.name.value;
      const concreteTypes = this.abstractToConcreteTypeNames.get(memberName);
      if (concreteTypes) {
        concreteTypes.add(memberName);
      } else {
        this.abstractToConcreteTypeNames.set(unionName, new Set<string>([memberName]));
      }
    }
  }

  isFieldShareable(node: FieldDefinitionNode, parent: ParentContainer | ExtensionContainer): boolean {
    return (
      !this.isCurrentSubgraphVersionTwo ||
      this.areFieldsShareable ||
      isNodeShareable(node) ||
      (this.isCurrentParentEntity && this.isFieldEntityKey(parent))
    );
  }

  addPotentiallyUnresolvableField(parent: ObjectContainer | ObjectExtensionContainer, fieldName: string) {
    const fieldContainer = getOrThrowError(parent.fields, fieldName);
    for (const [responseTypeName, operation] of this.rootTypeFieldsByResponseTypeName) {
      // If the operation response type has no path to the parent type, continue
      const paths = allSimplePaths(this.graph, responseTypeName, this.parentTypeName);
      if (responseTypeName === this.parentTypeName) {
        paths.push([this.parentTypeName]);
      } else if (paths.length < 1) {
        continue;
      }
      // Construct all possible paths to the unresolvable field but with the fieldName relationship between nodes
      const partialResolverPaths: string[] = [];
      for (const path of paths) {
        let hasEntityAncestor = false;
        let resolverPath: string = '';
        for (let i = 0; i < path.length - 1; i++) {
          const pathParent = path[i];
          // The field in question is resolvable if it has an entity ancestor within the same subgraph
          // Unresolvable fields further up the chain will be handled elsewhere
          const entity = this.entityMap.get(pathParent);
          if (entity && entity.subgraphs.has(this.currentSubgraphName)) {
            hasEntityAncestor = true;
            break;
          }
          const edges = this.graph.edges(pathParent, path[i + 1])!;
          // If there are multiple edges, pick the first one
          const inlineFragment: string | undefined = this.graph.getEdgeAttribute(edges[0], INLINE_FRAGMENT);
          const edgeName: string = this.graph.getEdgeAttribute(edges[0], FIELD_NAME);
          // If the parent field is an abstract type, the child should be proceeded by an inline fragment
          resolverPath += edgeName + (inlineFragment || '.');
        }
        if (hasEntityAncestor) {
          continue;
        }
        // Add the unresolvable field to each path
        resolverPath += fieldName;
        // If the field could have fields itself, add ellipsis
        if (this.graph.hasNode(fieldContainer.rootTypeName)) {
          resolverPath += ' { ... }';
        }
        partialResolverPaths.push(resolverPath);
      }
      if (partialResolverPaths.length < 1) {
        return;
      }
      // Each of these operations returns a type that has a path to the parent
      for (const [operationFieldPath, operationField] of operation) {
        // If the operation is defined in a subgraph that the field is defined, it is resolvable
        if (doSetsHaveAnyOverlap(fieldContainer.subgraphs, operationField.subgraphs)) {
          continue;
        }
        const fullResolverPaths: string[] = [];
        // The field is still resolvable if it's defined and resolved in another graph (but that isn't yet known)
        // Consequently, the subgraphs must be compared later to determine that the field is always resolvable
        for (const partialResolverPath of partialResolverPaths) {
          fullResolverPaths.push(`${operationFieldPath}${operationField.inlineFragment}${partialResolverPath}`);
        }
        const potentiallyUnresolvableField: PotentiallyUnresolvableField = {
          fieldContainer,
          fullResolverPaths,
          rootTypeField: operationField,
        };

        // The parent might already have unresolvable fields that have already been added
        const dependentResponsesByFieldName = this.sharedRootTypeFieldDependentResponses.get(this.parentTypeName);
        if (dependentResponsesByFieldName) {
          dependentResponsesByFieldName.push(potentiallyUnresolvableField);
          return;
        }
        this.sharedRootTypeFieldDependentResponses.set(this.parentTypeName, [potentiallyUnresolvableField]);
      }
    }
  }

  upsertFieldNode(node: FieldDefinitionNode) {
    const parent = this.isCurrentParentExtensionType
      ? getOrThrowError(this.extensions, this.parentTypeName)
      : getOrThrowError(this.parentMap, this.parentTypeName);
    if (
      parent.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      parent.kind !== Kind.INTERFACE_TYPE_DEFINITION &&
      parent.kind !== Kind.OBJECT_TYPE_EXTENSION
    ) {
      throw unexpectedKindFatalError(this.parentTypeName);
    }
    const fieldMap = parent.fields;
    const isFieldShareable = this.isFieldShareable(node, parent);
    const fieldPath = `${this.parentTypeName}.${this.childName}`;
    const fieldRootTypeName = getNamedTypeForChild(fieldPath, node.type);
    const existingFieldNode = fieldMap.get(this.childName);
    const entityParent = this.entityMap.get(this.parentTypeName);
    if (existingFieldNode) {
      existingFieldNode.appearances += 1;
      existingFieldNode.node.description = existingFieldNode.node.description || node.description;
      existingFieldNode.subgraphs.add(this.currentSubgraphName);
      existingFieldNode.subgraphsByShareable.set(this.currentSubgraphName, isFieldShareable);
      const { typeErrors, typeNode } = getLeastRestrictiveMergedTypeNode(
        existingFieldNode.node.type,
        node.type,
        this.parentTypeName,
        this.childName,
      );
      if (typeNode) {
        existingFieldNode.node.type = typeNode;
      } else {
        if (!typeErrors || typeErrors.length < 2) {
          throw fieldTypeMergeFatalError(this.childName);
        }
        this.errors.push(
          incompatibleChildTypesError(this.parentTypeName, this.childName, typeErrors[0], typeErrors[1]),
        );
      }
      this.upsertArgumentsForFieldNode(node, existingFieldNode);
      // If the parent is not an interface and both fields are not shareable, is it is a shareable error
      if (!this.isCurrentParentInterface && (!existingFieldNode.isShareable || !isFieldShareable)) {
        const shareableErrorTypeNames = this.shareableErrorTypeNames.get(this.parentTypeName);
        if (shareableErrorTypeNames) {
          shareableErrorTypeNames.add(this.childName);
        } else {
          this.shareableErrorTypeNames.set(this.parentTypeName, new Set<string>([this.childName]));
        }
      }
      return;
    }
    this.outputFieldTypeNameSet.add(fieldRootTypeName);
    fieldMap.set(this.childName, {
      appearances: 1,
      arguments: this.extractArgumentsFromFieldNode(node, new Map<string, ArgumentContainer>()),
      isShareable: isFieldShareable,
      node: fieldDefinitionNodeToMutable(node, this.parentTypeName),
      rootTypeName: fieldRootTypeName,
      subgraphs: new Set<string>([this.currentSubgraphName]),
      subgraphsByShareable: new Map<string, boolean>([[this.currentSubgraphName, isFieldShareable]]),
    });

    if (
      this.isParentRootType ||
      entityParent?.fields.has(this.childName) ||
      parent.kind === Kind.INTERFACE_TYPE_DEFINITION
    ) {
      return;
    }
    this.addPotentiallyUnresolvableField(parent, this.childName);
  }

  upsertValueNode(node: EnumValueDefinitionNode | InputValueDefinitionNode) {
    const parent = this.parentMap.get(this.parentTypeName);
    switch (node.kind) {
      case Kind.ENUM_VALUE_DEFINITION:
        if (!parent) {
          // This should never happen
          throw federationInvalidParentTypeError(this.parentTypeName, this.childName);
        }
        if (parent.kind !== Kind.ENUM_TYPE_DEFINITION) {
          throw incompatibleParentKindFatalError(this.parentTypeName, Kind.ENUM_TYPE_DEFINITION, parent.kind);
        }
        const enumValues = parent.values;
        const enumValue = enumValues.get(this.childName);
        if (enumValue) {
          enumValue.node.description = enumValue.node.description || node.description;
          enumValue.appearances += 1;
          return;
        }
        enumValues.set(this.childName, {
          appearances: 1,
          node: enumValueDefinitionNodeToMutable(node),
        });
        return;
      case Kind.INPUT_VALUE_DEFINITION:
        if (!parent || !this.isParentInputObject) {
          // TODO handle directives
          return;
        }
        if (parent.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION) {
          throw incompatibleParentKindFatalError(this.parentTypeName, Kind.INPUT_OBJECT_TYPE_DEFINITION, parent.kind);
        }
        const inputValues = parent.fields;
        const inputValue = inputValues.get(this.childName);
        if (inputValue) {
          inputValue.appearances += 1;
          inputValue.node.description = inputValue.node.description || node.description;
          const { typeErrors, typeNode } = getMostRestrictiveMergedTypeNode(
            inputValue.node.type,
            node.type,
            this.parentTypeName,
            this.childName,
          );
          if (typeNode) {
            inputValue.node.type = typeNode;
          } else {
            if (!typeErrors || typeErrors.length < 2) {
              throw fieldTypeMergeFatalError(this.childName);
            }
            this.errors.push(
              incompatibleChildTypesError(this.parentTypeName, this.childName, typeErrors[0], typeErrors[1]),
            );
          }
          return;
        }
        const valuePath = `${this.parentTypeName}.${this.childName}`;
        const inputValueNamedType = getNamedTypeForChild(valuePath, node.type);
        this.inputFieldTypeNameSet.add(inputValueNamedType);
        inputValues.set(this.childName, {
          appearances: 1,
          includeDefaultValue: !!node.defaultValue,
          node: inputValueDefinitionNodeToMutable(node, this.parentTypeName),
        });
        return;
      default:
        throw unexpectedKindFatalError(this.childName);
    }
  }

  upsertParentNode(node: TypeDefinitionNode) {
    const parentTypeName = node.name.value;
    const parent = this.parentMap.get(parentTypeName);
    if (parent) {
      parent.node.description = parent.node.description || node.description;
      parent.appearances += 1;
    }
    switch (node.kind) {
      case Kind.ENUM_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          return;
        }
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          values: new Map<string, EnumValueContainer>(),
          kind: node.kind,
          node: enumTypeDefinitionNodeToMutable(node),
        });
        return;
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          return;
        }
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          fields: new Map<string, InputValueContainer>(),
          kind: node.kind,
          node: inputObjectTypeDefinitionNodeToMutable(node),
        });
        return;
      case Kind.INTERFACE_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          extractInterfaces(node, parent.interfaces);
          parent.subgraphs.add(this.currentSubgraphName);
          return;
        }
        const nestedInterfaces = new Set<string>();
        extractInterfaces(node, nestedInterfaces);
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          fields: new Map<string, FieldContainer>(),
          interfaces: nestedInterfaces,
          kind: node.kind,
          node: interfaceTypeDefinitionNodeToMutable(node),
          subgraphs: new Set<string>([this.currentSubgraphName]),
        });
        return;
      case Kind.SCALAR_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          return;
        }
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          kind: node.kind,
          node: scalarTypeDefinitionNodeToMutable(node),
        });
        return;
      case Kind.OBJECT_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          extractInterfaces(node, parent.interfaces);
          extractEntityKeys(node, parent.entityKeys);
          parent.subgraphs.add(this.currentSubgraphName);
          return;
        }
        const interfaces = new Set<string>();
        extractInterfaces(node, interfaces);
        const entityKeys = new Set<string>();
        extractEntityKeys(node, entityKeys);
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          fields: new Map<string, FieldContainer>(),
          entityKeys,
          interfaces,
          isRootType: this.isParentRootType,
          kind: node.kind,
          node: objectTypeDefinitionNodeToMutable(node),
          subgraphs: new Set<string>([this.currentSubgraphName]),
        });
        return;
      case Kind.UNION_TYPE_DEFINITION:
        if (parent) {
          if (parent.kind !== node.kind) {
            throw incompatibleParentKindFatalError(parentTypeName, node.kind, parent.kind);
          }
          if (!node.types || node.types.length < 1) {
            this.errors.push(invalidUnionError(parent.node.name.value));
            return;
          }
          node.types?.forEach((member) => parent.members.add(member.name.value));
          return;
        }
        this.parentMap.set(parentTypeName, {
          appearances: 1,
          kind: node.kind,
          members: new Set<string>(node.types?.map((member) => member.name.value)),
          node: unionTypeDefinitionNodeToMutable(node),
        });
        return;
    }
  }

  upsertConcreteObjectLikeRootTypeFieldNode(
    fieldName: string,
    fieldTypeName: string,
    rootTypeFieldPath: string,
    responseType: string,
    concreteTypeName = fieldTypeName,
    hasAbstractParent = false,
  ) {
    const rootTypeFields = this.rootTypeFieldsByResponseTypeName.get(concreteTypeName);
    if (!rootTypeFields) {
      this.rootTypeFieldsByResponseTypeName.set(
        concreteTypeName,
        new Map<string, RootTypeField>([
          [
            rootTypeFieldPath,
            {
              inlineFragment: hasAbstractParent ? getInlineFragmentString(concreteTypeName) : '.',
              name: fieldName,
              parentTypeName: this.parentTypeName,
              path: rootTypeFieldPath,
              responseType,
              rootTypeName: fieldTypeName,
              subgraphs: new Set<string>([this.currentSubgraphName]),
            },
          ],
        ]),
      );
      return;
    }
    const rootTypeField = rootTypeFields.get(rootTypeFieldPath);
    if (rootTypeField) {
      rootTypeField.subgraphs.add(this.currentSubgraphName);
      return;
    }
    rootTypeFields.set(rootTypeFieldPath, {
      inlineFragment: hasAbstractParent ? getInlineFragmentString(concreteTypeName) : '.',
      name: fieldName,
      parentTypeName: this.parentTypeName,
      path: rootTypeFieldPath,
      responseType,
      rootTypeName: fieldTypeName,
      subgraphs: new Set<string>([this.currentSubgraphName]),
    });
  }

  upsertAbstractObjectLikeRootTypeFieldNode(
    fieldName: string,
    fieldTypeName: string,
    rootTypeFieldPath: string,
    responseType: string,
    concreteTypeNames: Set<string>,
  ) {
    for (const concreteTypeName of concreteTypeNames) {
      if (!this.graph.hasNode(concreteTypeName)) {
        throw invalidMultiGraphNodeFatalError(concreteTypeName); // should never happen
      }
      if (!this.graphEdges.has(rootTypeFieldPath)) {
        this.graph.addEdge(this.parentTypeName, concreteTypeName, { fieldName });
      }
      // Always upsert the operation field node to record subgraph appearances
      this.upsertConcreteObjectLikeRootTypeFieldNode(
        fieldName,
        fieldTypeName,
        rootTypeFieldPath,
        responseType,
        concreteTypeName,
        true,
      );
    }
    // Add the path so the edges are not added again
    this.graphEdges.add(rootTypeFieldPath);
  }

  validatePotentiallyUnresolvableFields() {
    if (this.sharedRootTypeFieldDependentResponses.size < 1) {
      return;
    }
    for (const [parentTypeName, potentiallyUnresolvableFields] of this.sharedRootTypeFieldDependentResponses) {
      for (const potentiallyUnresolvableField of potentiallyUnresolvableFields) {
        // There is no issue if the field is resolvable from at least one subgraph
        const operationField = potentiallyUnresolvableField.rootTypeField;
        const fieldContainer = potentiallyUnresolvableField.fieldContainer;
        if (doSetsHaveAnyOverlap(fieldContainer.subgraphs, operationField.subgraphs)) {
          continue;
        }
        const fieldSubgraphs = [...fieldContainer.subgraphs].join('", "');
        this.errors.push(
          unresolvableFieldError(
            operationField,
            fieldContainer.node.name.value,
            potentiallyUnresolvableField.fullResolverPaths,
            fieldSubgraphs,
            parentTypeName,
          ),
        );
      }
    }
  }

  upsertExtensionNode(node: ObjectTypeExtensionNode) {
    const extension = this.extensions.get(this.parentTypeName);
    if (extension) {
      if (extension.kind !== Kind.OBJECT_TYPE_EXTENSION) {
        throw incompatibleParentKindFatalError(this.parentTypeName, Kind.OBJECT_TYPE_EXTENSION, extension.kind);
      }
      extension.appearances += 1;
      extension.subgraphs.add(this.currentSubgraphName);
      extractInterfaces(node, extension.interfaces);
      return;
    }
    // build a new extension
    const interfaces = new Set<string>();
    extractInterfaces(node, interfaces);
    const entityKeys = new Set<string>();
    extractEntityKeys(node, entityKeys);
    this.extensions.set(this.parentTypeName, {
      appearances: 1,
      subgraphs: new Set<string>([this.currentSubgraphName]),
      isRootType: this.isParentRootType,
      kind: Kind.OBJECT_TYPE_EXTENSION,
      node: objectTypeExtensionNodeToMutable(node),
      fields: new Map<string, FieldContainer>(),
      entityKeys,
      interfaces,
    });
  }

  getAndValidateImplementedInterfaces(container: ObjectContainer | InterfaceContainer): NamedTypeNode[] {
    const interfaces: NamedTypeNode[] = [];
    if (container.interfaces.size < 1) {
      return interfaces;
    }
    const implementationErrorsMap = new Map<string, ImplementationErrors>();
    for (const interfaceName of container.interfaces) {
      interfaces.push(stringToNamedTypeNode(interfaceName));
      const interfaceContainer = getOrThrowError(this.parentMap, interfaceName);
      if (interfaceContainer.kind !== Kind.INTERFACE_TYPE_DEFINITION) {
        throw incompatibleParentKindFatalError(interfaceName, Kind.INTERFACE_TYPE_DEFINITION, interfaceContainer.kind);
      }
      const implementationErrors: ImplementationErrors = {
        invalidFieldImplementations: new Map<string, InvalidFieldImplementation>(),
        unimplementedFields: [],
      };
      let hasErrors = false;
      for (const [fieldName, interfaceField] of interfaceContainer.fields) {
        let hasNestedErrors = false;
        const containerField = container.fields.get(fieldName);
        if (!containerField) {
          hasErrors = true;
          implementationErrors.unimplementedFields.push(fieldName);
          continue;
        }
        const invalidFieldImplementation: InvalidFieldImplementation = {
          invalidAdditionalArguments: new Set<string>(),
          invalidImplementedArguments: [],
          originalResponseType: printTypeNode(interfaceField.node.type),
          unimplementedArguments: new Set<string>(),
        };
        // The implemented field type must be equally or more restrictive than the original interface field type
        if (!isTypeValidImplementation(interfaceField.node.type, containerField.node.type)) {
          hasErrors = true;
          hasNestedErrors = true;
          invalidFieldImplementation.implementedResponseType = printTypeNode(containerField.node.type);
        }
        const handledArguments = new Set<string>();
        for (const [argumentName, inputValueContainer] of interfaceField.arguments) {
          const interfaceArgument = inputValueContainer.node;
          handledArguments.add(argumentName);
          const containerArgument = containerField.arguments.get(argumentName)?.node;
          // The type implementing the interface must include all arguments with no variation for that argument
          if (!containerArgument) {
            hasErrors = true;
            hasNestedErrors = true;
            invalidFieldImplementation.unimplementedArguments.add(argumentName);
            continue;
          }
          // Implemented arguments should be the exact same type
          const actualType = printTypeNode(containerArgument.type);
          const expectedType = printTypeNode(interfaceArgument.type);
          if (expectedType !== actualType) {
            hasErrors = true;
            hasNestedErrors = true;
            invalidFieldImplementation.invalidImplementedArguments.push({ actualType, argumentName, expectedType });
          }
        }
        // Additional arguments must be optional (nullable)
        for (const [argumentName, inputValueContainer] of containerField.arguments) {
          const argumentNode = inputValueContainer.node;
          if (handledArguments.has(argumentName)) {
            continue;
          }
          if (argumentNode.type.kind !== Kind.NON_NULL_TYPE) {
            continue;
          }
          hasErrors = true;
          hasNestedErrors = true;
          invalidFieldImplementation.invalidAdditionalArguments.add(argumentName);
        }
        if (hasNestedErrors) {
          implementationErrors.invalidFieldImplementations.set(fieldName, invalidFieldImplementation);
        }
      }
      if (hasErrors) {
        implementationErrorsMap.set(interfaceName, implementationErrors);
      }
    }
    if (implementationErrorsMap.size) {
      this.errors.push(unimplementedInterfaceFieldsError(
        container.node.name.value, kindToTypeString(container.kind), implementationErrorsMap,
      ));
    }
    return interfaces;
  }

  getFieldDefinitionNodeWithMergedArguments(fieldContainer: FieldContainer, parentTypeName: string): FieldDefinitionNode {
    if (!fieldContainer.arguments) {
      return fieldContainer.node;
    }
    const fieldName = fieldContainer.node.name.value;
    const fieldPath = `${parentTypeName}.${fieldName}`;
    const args: InputValueDefinitionNode[] = [];
    const errors: InvalidRequiredArgument[] = [];
    const argumentNames: string[] = [];
    for (const argumentContainer of fieldContainer.arguments.values()) {
      const missingSubgraphs = getEntriesNotInHashSet(
        fieldContainer.subgraphs, argumentContainer.subgraphs,
      );
      const argumentName = argumentContainer.node.name.value;
      if (missingSubgraphs.length > 0) {
        // Required arguments must be defined in all subgraphs that define the field
        if (argumentContainer.requiredSubgraphs.size > 0) {
          errors.push({
            argumentName,
            missingSubgraphs,
            requiredSubgraphs: [...argumentContainer.requiredSubgraphs]
          });
        }
        // If the argument is always optional, but it's not defined in all subgraphs that define the field,
        // the argument should not be included in the federated graph
        continue;
      }
      argumentContainer.node.defaultValue = argumentContainer.includeDefaultValue
        ? argumentContainer.node.defaultValue : undefined;
      args.push(argumentContainer.node);
      argumentNames.push(argumentName);
    }
    if (errors.length > 0) {
      this.errors.push(invalidRequiredArgumentsError(fieldPath, errors));
    } else if (argumentNames.length > 0) {
      this.argumentConfigurations.push({
        argumentNames,
        fieldName,
        typeName: parentTypeName
      });
    }
    fieldContainer.node.arguments = args;
    return fieldContainer.node;
  }

  federate(): FederationResultContainer {
    this.populateMultiGraphAndRenameOperations(this.subgraphs);
    const factory = this;
    for (const subgraph of this.subgraphs) {
      this.isCurrentSubgraphVersionTwo = subgraph.isVersionTwo;
      this.currentSubgraphName = subgraph.name;
      walkSubgraphToFederate(subgraph.definitions, factory);
    }
    this.validatePotentiallyUnresolvableFields();
    const definitions: MutableTypeDefinitionNode[] = [];
    for (const definition of this.directiveDefinitions.values()) {
      definitions.push(definition);
    }
    for (const [typeName, extension] of this.extensions) {
      if (extension.isRootType && !this.parentMap.has(typeName)) {
        this.upsertParentNode(objectTypeExtensionNodeToMutableDefinitionNode(extension.node));
      }
      const baseObject = this.parentMap.get(typeName);
      if (!baseObject) {
        this.errors.push(noBaseTypeExtensionError(typeName));
        continue;
      }

      if (baseObject.kind !== Kind.OBJECT_TYPE_DEFINITION) {
        throw incompatibleParentKindFatalError(typeName, Kind.OBJECT_TYPE_DEFINITION, baseObject.kind);
      }
      // TODO check directives
      for (const [fieldName, field] of extension.fields) {
        const baseField = baseObject.fields.get(fieldName);
        if (!baseField) {
          baseObject.fields.set(fieldName, field);
          continue;
        }
        if (baseField.isShareable && field.isShareable) {
          continue;
        }

        const parent = this.shareableErrorTypeNames.get(typeName);
        if (parent) {
          parent.add(fieldName);
          continue;
        }
        this.shareableErrorTypeNames.set(typeName, new Set<string>([fieldName]));
      }
      for (const interfaceName of extension.interfaces) {
        baseObject.interfaces.add(interfaceName);
      }
    }
    for (const [parentTypeName, children] of this.shareableErrorTypeNames) {
      const parent = getOrThrowError(this.parentMap, parentTypeName);
      if (parent.kind !== Kind.OBJECT_TYPE_DEFINITION) {
        throw incompatibleParentKindFatalError(parentTypeName, Kind.OBJECT_TYPE_DEFINITION, parent.kind);
      }
      this.errors.push(shareableFieldDefinitionsError(parent, children));
    }
    const objectLikeContainersWithInterfaces: ObjectLikeContainer[] = [];
    for (const parent of this.parentMap.values()) {
      const parentTypeName = parent.node.name.value;
      switch (parent.kind) {
        case Kind.ENUM_TYPE_DEFINITION:
          const values: EnumValueDefinitionNode[] = [];
          const mergeMethod = this.getEnumMergeMethod(parentTypeName);
          for (const value of parent.values.values()) {
            switch (mergeMethod) {
              case MergeMethod.CONSISTENT:
                if (value.appearances < parent.appearances) {
                  this.errors.push(incompatibleSharedEnumError(parentTypeName));
                }
                values.push(value.node);
                break;
              case MergeMethod.INTERSECTION:
                if (value.appearances === parent.appearances) {
                  values.push(value.node);
                }
                break;
              default:
                values.push(value.node);
                break;
            }
          }
          parent.node.values = values;
          definitions.push(parent.node);
          break;
        case Kind.INPUT_OBJECT_TYPE_DEFINITION:
          const inputValues: InputValueDefinitionNode[] = [];
          for (const value of parent.fields.values()) {
            if (parent.appearances === value.appearances) {
              inputValues.push(value.node);
            } else if (isTypeRequired(value.node.type)) {
              this.errors.push(federationRequiredInputFieldError(parentTypeName, value.node.name.value));
              break;
            }
          }
          parent.node.fields = inputValues;
          definitions.push(parent.node);
          break;
        case Kind.INTERFACE_TYPE_DEFINITION:
          const interfaceFields: FieldDefinitionNode[] = [];
          for (const fieldContainer of parent.fields.values()) {
            interfaceFields.push(this.getFieldDefinitionNodeWithMergedArguments(fieldContainer, parentTypeName));
          }
          parent.node.fields = interfaceFields;
          // Interface implementations can only be evaluated after they've been fully merged
          if (parent.interfaces.size > 0) {
            objectLikeContainersWithInterfaces.push(parent);
          } else {
            definitions.push(parent.node);
          }
          break;
        case Kind.OBJECT_TYPE_DEFINITION:
          const fields: FieldDefinitionNode[] = [];
          for (const fieldContainer of parent.fields.values()) {
            fields.push(this.getFieldDefinitionNodeWithMergedArguments(fieldContainer, parentTypeName));
          }
          parent.node.fields = fields;
          // Interface implementations can only be evaluated after they've been fully merged
          if (parent.interfaces.size > 0) {
            objectLikeContainersWithInterfaces.push(parent);
          } else {
            definitions.push(parent.node);
          }
          break;
        case Kind.SCALAR_TYPE_DEFINITION:
          definitions.push(parent.node);
          break;
        case Kind.UNION_TYPE_DEFINITION:
          const types: NamedTypeNode[] = [];
          for (const memberName of parent.members) {
            types.push(stringToNamedTypeNode(memberName));
          }
          parent.node.types = types;
          definitions.push(parent.node);
          break;
      }
    }
    for (const container of objectLikeContainersWithInterfaces) {
      container.node.interfaces = this.getAndValidateImplementedInterfaces(container);
      definitions.push(container.node);
    }
    if (!this.parentMap.has(QUERY)) {
      this.errors.push(noQueryRootTypeError);
    }
    if (this.errors.length > 0) {
      return { errors: this.errors };
    }
    const newAst: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions,
    };
    return {
      federationResult: {
        argumentConfigurations: this.argumentConfigurations,
        federatedGraphAST: newAst,
        federatedGraphSchema: buildASTSchema(newAst),
      }
    };
  }
}
