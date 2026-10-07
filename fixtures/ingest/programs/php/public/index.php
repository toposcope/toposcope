<?php

declare(strict_types=1);

use Billing\Billing;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

$app->post('/pay', function (Request $request, Response $response): Response {
    $response->getBody()->write((new Billing())->charge([]));
    return $response;
});

// The uncaught-error path: the exception as the runtime prints it.
$errors = $app->addErrorMiddleware(false, false, false);
$errors->setDefaultErrorHandler(function (Request $request, \Throwable $error) use ($app): Response {
    file_put_contents(getenv('OUT'), (string) $error);
    file_put_contents(getenv('OUT') . '.type', get_class($error));
    return $app->getResponseFactory()->createResponse(500);
});

$app->handle((new ServerRequestFactory())->createServerRequest('POST', '/pay'));
