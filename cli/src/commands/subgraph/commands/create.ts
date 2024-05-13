import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EnumStatusCode } from '@wundergraph/cosmo-connect/dist/common/common_pb';
import {
  isValidSubscriptionProtocol,
  isValidWebsocketSubprotocol,
  parseGraphQLSubscriptionProtocol,
  parseGraphQLWebsocketSubprotocol,
  splitLabel,
} from '@wundergraph/cosmo-shared';
import { Command, program } from 'commander';
import { resolve } from 'pathe';
import pc from 'picocolors';
import ora from 'ora';
import { getBaseHeaders } from '../../../core/config.js';
import { BaseCommandOptions } from '../../../core/types/types.js';

export default (opts: BaseCommandOptions) => {
  const command = new Command('create');
  command.description('Creates a federated subgraph on the control plane.');
  command.argument(
    '<name>',
    'The name of the subgraph to create. It is usually in the format of <org>.<service.name> and is used to uniquely identify your subgraph.',
  );
  command.option('-n, --namespace [string]', 'The namespace of the subgraph.');
  command.requiredOption(
    '-r, --routing-url <url>',
    'The routing url of your subgraph. This is the url that the subgraph will be accessible at.',
  );
  command.option(
    '--label [labels...]',
    'The labels to apply to the subgraph. The labels are passed in the format <key>=<value> <key>=<value>.',
  );
  command.option(
    '--subscription-url [url]',
    'The url used for subscriptions. If empty, it defaults to same url used for routing.',
  );
  command.option(
    '--subscription-protocol <protocol>',
    'The protocol to use when subscribing to the subgraph. The supported protocols are ws, sse, and sse_post.',
  );
  command.option(
    '--websocket-subprotocol <protocol>',
    'The subprotocol to use when subscribing to the subgraph. The supported protocols are auto, graphql-ws, and graphql-transport-ws. Should be used only if the subscription protocol is ws.For more information see https://cosmo-docs.wundergraph.com/router/subscriptions/websocket-subprotocols',
  );
  command.option('--readme <path-to-readme>', 'The markdown file which describes the subgraph.');
  command.action(async (name, options) => {
    let readmeFile;
    if (options.readme) {
      readmeFile = resolve(process.cwd(), options.readme);
      if (!existsSync(readmeFile)) {
        program.error(
          pc.red(
            pc.bold(`The readme file '${pc.bold(readmeFile)}' does not exist. Please check the path and try again.`),
          ),
        );
      }
    }

    if (options.subscriptionProtocol && !isValidSubscriptionProtocol(options.subscriptionProtocol)) {
      program.error(
        pc.red(
          pc.bold(
            `The subscription protocol '${pc.bold(
              options.subscriptionProtocol,
            )}' is not valid. Please use one of the following: sse, sse_post, ws.`,
          ),
        ),
      );
    }

    if (options.websocketSubprotocol) {
      if (options.subscriptionProtocol !== 'ws') {
        program.error(
          pc.red(
            pc.bold(
              `The websocket subprotocol '${pc.bold(
                options.websocketSubprotocol,
              )}' can only be used if the subscription protocol is 'ws'.`,
            ),
          ),
        );
      }
      if (!isValidWebsocketSubprotocol(options.websocketSubprotocol)) {
        program.error(
          pc.red(
            pc.bold(
              `The websocket subprotocol '${pc.bold(
                options.websocketSubprotocol,
              )}' is not valid. Please use one of the following: auto, graphql-ws, graphql-transport-ws.`,
            ),
          ),
        );
      }
    }

    const spinner = ora('Subgraph is being created...').start();
    const resp = await opts.client.platform.createFederatedSubgraph(
      {
        name,
        namespace: options.namespace,
        labels: options.label ? options.label.map((label: string) => splitLabel(label)) : [],
        routingUrl: options.routingUrl,
        // If the argument is provided but the URL is not, clear it
        subscriptionUrl: options.subscriptionUrl === true ? '' : options.subscriptionUrl,
        subscriptionProtocol: options.subscriptionProtocol
          ? parseGraphQLSubscriptionProtocol(options.subscriptionProtocol)
          : undefined,
        websocketSubprotocol: options.websocketSubprotocol
          ? parseGraphQLWebsocketSubprotocol(options.websocketSubprotocol)
          : undefined,
        readme: readmeFile ? await readFile(readmeFile, 'utf8') : undefined,
      },
      {
        headers: getBaseHeaders(),
      },
    );

    if (resp.response?.code === EnumStatusCode.OK) {
      spinner.succeed('Subgraph was created successfully.');
    } else {
      spinner.fail('Failed to create subgraph.');
      if (resp.response?.details) {
        console.log(pc.red(pc.bold(resp.response?.details)));
      }
      process.exit(1);
    }
  });

  return command;
};
